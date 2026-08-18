import { ConfigService } from '@nestjs/config';

import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AnaliticaComisionesService } from './analitica-comisiones.service';
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
    new AnaliticaComisionesService(prisma),
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

  /* Sin esto, el sobre decía "pagina 1 de 17, 25 por pagina" mientras mandaba
     las 418 filas: un paginador futuro pintaría 16 páginas inexistentes. */
  it('el sobre describe lo que de verdad se mandó', async () => {
    const v = await vendedora('PeU');
    await sembrar(v.id, 418);

    const r = await planilla.listarVentas(periodoId, { vendedoraId: v.id, mesCompleto: true });

    expect(r.totalPaginas).toBe(1);
    expect(r.pagina).toBe(1);
    expect(r.datos.length).toBeLessThanOrEqual(r.limite);
  });

  it('el reparto por canal sigue cuadrando con lo que se devuelve', async () => {
    const v = await vendedora('PeV');
    await sembrar(v.id, 418);

    const r = await planilla.listarVentas(periodoId, { vendedoraId: v.id, mesCompleto: true });

    expect(canalesDe(r).total).toBe(418);
    expect(canalesDe(r).total).toBe(r.datos.length);
  });
});

describe('filtro por tipo de comisión', () => {
  async function ventaTipo(tipo: 'A' | 'B' | 'C', clasif: 'PLANPAQ' | 'CIRUGIA' | 'CONSULTA') {
    await prisma.ventaImportada.create({
      data: {
        periodoId,
        detalle: `Servicio ${clasif}`,
        precio: 100,
        canal: 'PROPIO',
        ingresoNeto: 87,
        unidadNegocio: 'VARIOS',
        clasif,
        tipo,
        comisionable: true,
      },
    });
  }

  /* El tipo agrupa varias clasificaciones, así que no se podía acotar con el
     filtro que ya había: revisar "todo lo que paga por Tipo B" era imposible. */
  it('acota a un tipo y deja fuera los demás', async () => {
    await ventaTipo('A', 'PLANPAQ');
    await ventaTipo('B', 'CIRUGIA');
    await ventaTipo('C', 'CONSULTA');
    await ventaTipo('C', 'CONSULTA');

    const r = await planilla.listarVentas(periodoId, { tipo: 'C' });

    expect(r.total).toBe(2);
    expect(r.datos.every(d => d.tipo === 'C')).toBe(true);
  });

  it('sin filtro devuelve los tres tipos', async () => {
    await ventaTipo('A', 'PLANPAQ');
    await ventaTipo('B', 'CIRUGIA');
    await ventaTipo('C', 'CONSULTA');

    expect((await planilla.listarVentas(periodoId, {})).total).toBe(3);
  });

  it('se combina con la clasificación en vez de sustituirla', async () => {
    await ventaTipo('C', 'CONSULTA');
    await ventaTipo('B', 'CIRUGIA');

    const r = await planilla.listarVentas(periodoId, { tipo: 'C', clasif: 'CIRUGIA' });

    expect(r.total).toBe(0);
  });
});

describe('totales y subtotales del listado de ventas', () => {
  async function vender(vendedoraId: string, n: number, precio: number) {
    await prisma.ventaImportada.createMany({
      data: Array.from({ length: n }, () => ({
        periodoId,
        vendedoraId,
        detalle: 'Servicio',
        precio,
        canal: 'PROPIO' as const,
        ingresoNeto: precio * 0.87,
        unidadNegocio: 'VARIOS' as const,
        clasif: 'OTROSS' as const,
        tipo: 'C' as const,
        comisionable: true,
      })),
    });
  }

  async function vendedora(codigo: string, nombre: string) {
    return prisma.vendedoraComision.create({ data: { codigo, nombre, configurada: true } });
  }

  /* Lo que no puede volver a pasar: sumar en el navegador lo que llegó y
     presentarlo como el total del mes. Con 150 ventas y una página de 10, el
     total tiene que seguir siendo el de las 150. */
  it('el total es del filtro entero, no de la página', async () => {
    const v = await vendedora('PeT', 'Total');
    await vender(v.id, 150, 100);

    const r = await planilla.listarVentas(periodoId, { limite: 10 });

    expect(r.datos).toHaveLength(10);
    expect(r.totales.ventas).toBe(150);
    expect(r.totales.monto).toBeCloseTo(15000, 2);
    expect(r.totales.base).toBeCloseTo(13050, 2);
  });

  it('da un subtotal por vendedora, de mayor a menor', async () => {
    const a = await vendedora('PeM', 'Mucho');
    const b = await vendedora('PeP', 'Poco');
    await vender(a.id, 10, 500);
    await vender(b.id, 3, 100);

    const r = await planilla.listarVentas(periodoId, { limite: 5 });

    expect(r.porVendedora).toHaveLength(2);
    expect(r.porVendedora[0]).toMatchObject({ nombre: 'Mucho', ventas: 10 });
    expect(r.porVendedora[0].monto).toBeCloseTo(5000, 2);
    expect(r.porVendedora[1]).toMatchObject({ nombre: 'Poco', ventas: 3 });
  });

  it('los subtotales suman exactamente el total', async () => {
    const a = await vendedora('PeX1', 'A');
    const b = await vendedora('PeX2', 'B');
    await vender(a.id, 7, 300);
    await vender(b.id, 5, 120);

    const r = await planilla.listarVentas(periodoId, { limite: 2 });

    const suma = r.porVendedora.reduce((t, v) => t + v.monto, 0);
    expect(suma).toBeCloseTo(r.totales.monto, 2);
    expect(r.porVendedora.reduce((t, v) => t + v.ventas, 0)).toBe(r.totales.ventas);
  });

  /* Los totales respetan el filtro: es "el total de lo que estoy viendo". */
  it('filtrar por tipo acota también los totales', async () => {
    const v = await vendedora('PeF', 'Filtrada');
    await vender(v.id, 4, 100);
    await prisma.ventaImportada.create({
      data: {
        periodoId, vendedoraId: v.id, detalle: 'Cirugia', precio: 900,
        canal: 'PROPIO', ingresoNeto: 783, unidadNegocio: 'VARIOS',
        clasif: 'CIRUGIA', tipo: 'B', comisionable: true,
      },
    });

    const r = await planilla.listarVentas(periodoId, { tipo: 'B' });

    expect(r.totales.ventas).toBe(1);
    expect(r.totales.monto).toBeCloseTo(900, 2);
  });

  it('sin ventas los totales son cero, no NaN', async () => {
    const r = await planilla.listarVentas(periodoId, {});

    expect(r.totales).toEqual({ ventas: 0, monto: 0, base: 0 });
    expect(r.porVendedora).toEqual([]);
  });
});
