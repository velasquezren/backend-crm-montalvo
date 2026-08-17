import { ConfigService } from '@nestjs/config';

import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CalculoComisionesService } from './calculo-comisiones.service';
import { CatalogoClinicoService } from './catalogo-clinico.service';
import { ConfiguracionComisionesService } from './configuracion-comisiones.service';
import { PlanillaComisionesService } from './planilla-comisiones.service';

/**
 * Pruebas del consolidado contra Postgres real (`crm_test` en el :5433 local).
 *
 * A diferencia de `verificacion-diciembre`, esta no necesita los Excel: siembra
 * los resultados directamente, porque lo que se comprueba no es el cálculo sino
 * que el pie de la tabla cuadre con sus filas.
 *
 * Y cuadrar importa aquí más que en cualquier otra vista: es el número que
 * administración compara contra su planilla para pagar. Un pie que no suma sus
 * propias filas no se detecta leyendo, se detecta en una discusión de sueldo.
 */

const URL_TEST =
  process.env['DATABASE_URL_TEST'] ??
  'postgresql://crm_app:crm_dev_local@localhost:5433/crm_test?schema=public';

if (!URL_TEST.includes('/crm_test')) {
  throw new Error('La suite de integración solo puede correr contra la base crm_test');
}

const prisma = new PrismaService({ datasources: { db: { url: URL_TEST } } });

let calculo: CalculoComisionesService;
let planilla: PlanillaComisionesService;
let periodoId: string;

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.resultadoComision.deleteMany();
  await prisma.ventaImportada.deleteMany();
  await prisma.periodoComision.deleteMany();
  await prisma.vendedoraComision.deleteMany();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.resultadoComision.deleteMany();
  await prisma.ventaImportada.deleteMany();
  await prisma.periodoComision.deleteMany();
  await prisma.vendedoraComision.deleteMany();

  calculo = new CalculoComisionesService(
    prisma,
    new ConfiguracionComisionesService(prisma),
    new AuditService(prisma),
  );
  planilla = new PlanillaComisionesService(
    prisma,
    new ConfiguracionComisionesService(prisma),
    new AuditService(prisma),
    new CatalogoClinicoService(prisma),
  );
  jest.spyOn(calculo['logger'], 'warn').mockImplementation(() => undefined);
  jest.spyOn(calculo['logger'], 'log').mockImplementation(() => undefined);

  const periodo = await prisma.periodoComision.create({
    data: { anio: 2025, mes: 12, tipoCambio: 6.97 },
  });
  periodoId = periodo.id;
});

/** Una vendedora con su resultado ya liquidado, sueldo incluido. */
async function liquidada(codigo: string, sueldoBase: number, comisionBob: number) {
  const vendedora = await prisma.vendedoraComision.create({
    data: { codigo, nombre: `Vendedora ${codigo}`, sueldoBase, configurada: true },
  });
  await prisma.resultadoComision.create({
    data: {
      periodoId,
      vendedoraId: vendedora.id,
      totalBob: comisionBob,
      /* La foto del sueldo en el momento de liquidar, que es con la que se
         calculó el total ganado. */
      sueldoBase,
      totalGanado: comisionBob + sueldoBase,
    },
  });
  return vendedora;
}

describe('reporteConsolidado contra Postgres real', () => {
  it('el total de sueldos es la suma de las filas', async () => {
    await liquidada('Pe1', 4000, 1000);
    await liquidada('Pe2', 3500, 800);

    const reporte = await calculo.reporteConsolidado(periodoId);

    expect(reporte.totales.sueldoBase).toBe(7500);
  });

  it('el total ganado cuadra con comisiones más sueldos', async () => {
    await liquidada('Pe1', 4000, 1000);
    await liquidada('Pe2', 3500, 800);

    const { totales } = await calculo.reporteConsolidado(periodoId);

    expect(totales.totalGanado).toBe(totales.totalBob + totales.sueldoBase);
  });

  /**
   * La regresión que motivó la prueba.
   *
   * El total sumaba `vendedora.sueldoBase` —el dato maestro— mientras las filas
   * y los `totalGanado` ya guardados usan `ResultadoComision.sueldoBase`, la
   * foto del cierre. Basta un aumento para que un periodo ya pagado deje de
   * cuadrar consigo mismo.
   */
  it('un aumento posterior NO altera un periodo ya liquidado', async () => {
    const vendedora = await liquidada('Pe1', 4000, 1000);

    await prisma.vendedoraComision.update({
      where: { id: vendedora.id },
      data: { sueldoBase: 9000 },
    });

    const { totales, filas } = await calculo.reporteConsolidado(periodoId);

    expect(totales.sueldoBase).toBe(4000);
    expect(filas[0].sueldoBase).toBe(4000);
    expect(totales.totalGanado).toBe(totales.totalBob + totales.sueldoBase);
  });

  it('el pie coincide con la suma de las filas que se ven', async () => {
    await liquidada('Pe1', 4000, 1000);
    await liquidada('Pe2', 3500, 800);
    await liquidada('Pe3', 0, 250);

    const { totales, filas } = await calculo.reporteConsolidado(periodoId);

    const sumaFilas = filas.reduce((t, f) => t + f.sueldoBase, 0);
    expect(totales.sueldoBase).toBe(sumaFilas);
  });

  it('sin resultados el total es 0 y no NaN', async () => {
    const { totales } = await calculo.reporteConsolidado(periodoId);

    expect(totales.sueldoBase).toBe(0);
    expect(Number.isNaN(totales.sueldoBase)).toBe(false);
  });
});

/** El reparto que acompaña al listado; `limite: 1` prueba que no depende de la página. */
function canalesDe(respuesta: { canales: unknown }) {
  return respuesta.canales as {
    total: number;
    propios: number;
    empresa: number;
    pctPropio: number;
  };
}

describe('reparto por canal dentro del listado de ventas', () => {
  /** Siembra `n` ventas del canal dado para una vendedora. */
  async function ventas(vendedoraId: string, canal: 'PROPIO' | 'EMPRESA', n: number) {
    await prisma.ventaImportada.createMany({
      data: Array.from({ length: n }, () => ({
        periodoId,
        vendedoraId,
        detalle: 'Servicio',
        precio: 100,
        canal,
        ingresoNeto: 87,
        unidadNegocio: 'VARIOS' as const,
        clasif: 'OTROSS' as const,
        tipo: 'A' as const,
        comisionable: true,
      })),
    });
  }

  /**
   * La razón de ser del agregado. La vista contaba la página cargada —100
   * filas— como si fuera el mes; en producción 29 de 67 combinaciones
   * vendedora-mes la superan, con un máximo de 423.
   *
   * Viaja dentro del listado y no en un endpoint aparte: en este proyecto una
   * petición extra cuesta ~190 ms de red y el `groupBy` cuesta milisegundos
   * dentro de la transacción que ya se hacía.
   */
  it('cuenta el mes completo, no las primeras 100', async () => {
    const v = await prisma.vendedoraComision.create({
      data: { codigo: 'Pe9', nombre: 'Con muchas ventas', configurada: true },
    });
    await ventas(v.id, 'PROPIO', 90);
    await ventas(v.id, 'EMPRESA', 60);

    const stats = canalesDe(await planilla.listarVentas(periodoId, { vendedoraId: v.id, limite: 1 }));

    expect(stats.total).toBe(150);
    expect(stats.propios).toBe(90);
    expect(stats.empresa).toBe(60);
    expect(stats.pctPropio).toBe(60);
  });

  it('no mezcla las ventas de otra vendedora', async () => {
    const a = await prisma.vendedoraComision.create({
      data: { codigo: 'PeA', nombre: 'A', configurada: true },
    });
    const b = await prisma.vendedoraComision.create({
      data: { codigo: 'PeB', nombre: 'B', configurada: true },
    });
    await ventas(a.id, 'PROPIO', 10);
    await ventas(b.id, 'PROPIO', 40);

    expect((canalesDe(await planilla.listarVentas(periodoId, { vendedoraId: a.id, limite: 1 }))).total).toBe(10);
  });

  /* Mismo filtro que la liquidación: si contara las excluidas, el porcentaje no
     cuadraría con lo que se paga. */
  it('ignora las ventas no comisionables', async () => {
    const v = await prisma.vendedoraComision.create({
      data: { codigo: 'PeC', nombre: 'C', configurada: true },
    });
    await ventas(v.id, 'PROPIO', 5);
    await prisma.ventaImportada.create({
      data: {
        periodoId,
        vendedoraId: v.id,
        detalle: 'Excluida',
        precio: 100,
        canal: 'PROPIO',
        ingresoNeto: 87,
        unidadNegocio: 'VARIOS',
        clasif: 'OTROSS',
        tipo: 'A',
        comisionable: false,
      },
    });

    expect((canalesDe(await planilla.listarVentas(periodoId, { vendedoraId: v.id, limite: 1 }))).total).toBe(5);
  });

  it('sin ventas devuelve ceros y no NaN', async () => {
    const v = await prisma.vendedoraComision.create({
      data: { codigo: 'PeD', nombre: 'D', configurada: true },
    });

    const stats = canalesDe(await planilla.listarVentas(periodoId, { vendedoraId: v.id, limite: 1 }));

    expect(stats).toEqual({ total: 0, propios: 0, empresa: 0, pctPropio: 0 });
  });

  /* Sin vendedora no hay reparto: el porcentaje es de una persona, y calcularlo
     para el listado completo del mes no significaría nada. */
  it('no se calcula si no se filtra por vendedora', async () => {
    const respuesta = await planilla.listarVentas(periodoId, { limite: 1 });

    expect(respuesta.canales).toBeNull();
  });
});

describe('mes completo de una vendedora, para que su buscador no mienta', () => {
  async function sembrar(vendedoraId: string, n: number) {
    await prisma.ventaImportada.createMany({
      data: Array.from({ length: n }, (_, i) => ({
        periodoId,
        vendedoraId,
        detalle: `Servicio ${i}`,
        precio: 100,
        canal: 'PROPIO' as const,
        ingresoNeto: 87,
        unidadNegocio: 'VARIOS' as const,
        clasif: 'OTROSS' as const,
        tipo: 'A' as const,
        comisionable: true,
      })),
    });
  }

  async function vendedora(codigo: string) {
    return prisma.vendedoraComision.create({
      data: { codigo, nombre: `V ${codigo}`, configurada: true },
    });
  }

  /* El caso real: 418 ventas en un mes, de las que solo llegaban 100. */
  it('devuelve las 418 y no las primeras 100', async () => {
    const v = await vendedora('PeX');
    await sembrar(v.id, 418);

    const r = await planilla.listarVentas(periodoId, { vendedoraId: v.id, mesCompleto: true });

    expect(r.datos).toHaveLength(418);
    expect(r.total).toBe(418);
  });

  /* Lo que hacía invisible el servicio buscado: quedaba fuera de la página. */
  it('el último servicio del mes viaja, que es el que no se podía buscar', async () => {
    const v = await vendedora('PeY');
    await sembrar(v.id, 418);

    const r = await planilla.listarVentas(periodoId, { vendedoraId: v.id, mesCompleto: true });

    expect(r.datos.some(d => d.detalle === 'Servicio 417')).toBe(true);
  });

  it('sin la bandera sigue paginando de 100 en 100', async () => {
    const v = await vendedora('PeZ');
    await sembrar(v.id, 418);

    const r = await planilla.listarVentas(periodoId, { vendedoraId: v.id, limite: 100 });

    expect(r.datos).toHaveLength(100);
    expect(r.total).toBe(418);
  });

  /* La bandera no es una puerta trasera para vaciar la tabla entera: sin
     vendedora no aplica y vuelve la paginación. */
  it('la bandera sola, sin vendedora, no salta la paginación', async () => {
    const v = await vendedora('PeW');
    await sembrar(v.id, 418);

    const r = await planilla.listarVentas(periodoId, { mesCompleto: true });

    expect(r.datos.length).toBeLessThanOrEqual(100);
  });

  it('el reparto por canal sigue cuadrando con lo que se devuelve', async () => {
    const v = await vendedora('PeV');
    await sembrar(v.id, 418);

    const r = await planilla.listarVentas(periodoId, { vendedoraId: v.id, mesCompleto: true });

    expect(canalesDe(r).total).toBe(418);
    expect(canalesDe(r).total).toBe(r.datos.length);
  });
});
