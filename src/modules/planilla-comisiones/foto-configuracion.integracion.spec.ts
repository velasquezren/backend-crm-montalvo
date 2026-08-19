import { ConfigService } from '@nestjs/config';

import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AnaliticaComisionesService } from './analitica-comisiones.service';
import { CalculoComisionesService } from './calculo-comisiones.service';
import { ConfiguracionComisionesService } from './configuracion-comisiones.service';

/**
 * La foto de reglas que cada periodo guarda al liquidarse.
 *
 * Existe por una pregunta que hoy no se podía responder: "¿con qué reglas se
 * pagó enero?". Las tarifas, los niveles y los parámetros son globales, así que
 * cambiarlos altera lo que daría recalcular cualquier mes —incluido uno ya
 * pagado— y los números guardados quedan sin explicación.
 */

const URL_TEST =
  process.env['DATABASE_URL_TEST'] ??
  'postgresql://crm_app:crm_dev_local@localhost:5433/crm_test?schema=public';

if (!URL_TEST.includes('/crm_test')) {
  throw new Error('La suite de integración solo puede correr contra la base crm_test');
}

const prisma = new PrismaService({ datasources: { db: { url: URL_TEST } } });

let calculo: CalculoComisionesService;
let configuracion: ConfiguracionComisionesService;
let periodoId: string;
/* Estas pruebas cambian un parámetro GLOBAL, que no se borra entre suites como
   las filas. Sin devolverlo, la siguiente ejecución arranca con el área RA al
   4,5% y la reconciliación de diciembre da otros números — pasó al correr la
   suite dos veces seguidas. */
let raOriginal = 0;

beforeAll(async () => {
  await prisma.$connect();
});

afterEach(async () => {
  await prisma.parametroComision.update({
    where: { clave: 'PCT_TIPO_C_RA' },
    data: { valor: raOriginal },
  });
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

  configuracion = new ConfiguracionComisionesService(prisma);
  await configuracion.asegurarConfiguracion();

  calculo = new CalculoComisionesService(
    prisma,
    configuracion,
    new AuditService(prisma),
    new AnaliticaComisionesService(prisma),
  );
  jest.spyOn(calculo['logger'], 'warn').mockImplementation(() => undefined);
  jest.spyOn(calculo['logger'], 'log').mockImplementation(() => undefined);

  raOriginal = Number(
    (await prisma.parametroComision.findUniqueOrThrow({ where: { clave: 'PCT_TIPO_C_RA' } })).valor,
  );

  const periodo = await prisma.periodoComision.create({
    data: { anio: 2026, mes: 1, tipoCambio: 6.97 },
  });
  periodoId = periodo.id;

  const vendedora = await prisma.vendedoraComision.create({
    data: { codigo: 'Pe1', nombre: 'Vendedora', configurada: true, sueldoBase: 2750 },
  });
  await prisma.ventaImportada.create({
    data: {
      periodoId,
      vendedoraId: vendedora.id,
      detalle: 'Consulta',
      precio: 1000,
      canal: 'EMPRESA',
      ingresoNeto: 870,
      unidadNegocio: 'VARIOS',
      clasif: 'CONSULTA',
      tipo: 'C',
      comisionable: true,
    },
  });
});

/** La foto guardada, ya tipada para leerla. */
async function foto() {
  const p = await prisma.periodoComision.findUniqueOrThrow({ where: { id: periodoId } });
  return p.configuracionUsada as unknown as {
    calculadoEn: string;
    tipoCambio: number;
    parametros: Record<string, number>;
    tarifasServicio: { clasif: string; pctEmpresa: number }[];
    nivelesCirugia: { nivel: number }[];
    objetivos: { tipo: string }[];
  } | null;
}

describe('foto de la configuración usada', () => {
  it('antes de calcular no hay foto, y no se inventa una', async () => {
    expect(await foto()).toBeNull();
  });

  it('al calcular queda la foto con las reglas que decidieron el pago', async () => {
    await calculo.calcular(periodoId, 'usuario-1');
    const f = await foto();

    expect(f).not.toBeNull();
    expect(f!.tipoCambio).toBe(6.97);
    expect(f!.parametros['PCT_TIPO_C_RA']).toBeDefined();
    expect(f!.tarifasServicio.length).toBeGreaterThan(0);
    expect(f!.nivelesCirugia.length).toBeGreaterThan(0);
    expect(f!.objetivos.length).toBeGreaterThan(0);
  });

  /**
   * El caso que motivó todo: se cambia una regla DESPUÉS de liquidar. Los
   * números guardados no se mueven y la foto sigue contando la verdad de ese
   * cálculo, no la de la configuración actual.
   */
  it('cambiar un parámetro después NO altera la foto ya guardada', async () => {
    await calculo.calcular(periodoId, 'usuario-1');
    const antes = await foto();

    const nuevoValor = raOriginal + 0.045;
    await configuracion.actualizarParametro('PCT_TIPO_C_RA', { valor: nuevoValor });

    /* El parámetro sí cambió en la configuración global... */
    const vigente = await configuracion.cargarConfiguracion(periodoId);
    expect(vigente.parametros.get('PCT_TIPO_C_RA')).toBe(nuevoValor);

    /* ...pero la foto del periodo ya liquidado sigue contando su verdad. */
    const despues = await foto();
    expect(despues!.parametros['PCT_TIPO_C_RA']).toBe(antes!.parametros['PCT_TIPO_C_RA']);
    expect(despues!.parametros['PCT_TIPO_C_RA']).not.toBe(nuevoValor);
  });

  it('recalcular sí actualiza la foto, porque describe el resultado vigente', async () => {
    await calculo.calcular(periodoId, 'usuario-1');
    const antes = await foto();

    const nuevoValor = raOriginal + 0.045;
    await configuracion.actualizarParametro('PCT_TIPO_C_RA', { valor: nuevoValor });
    await calculo.calcular(periodoId, 'usuario-1');

    const despues = await foto();
    expect(despues!.parametros['PCT_TIPO_C_RA']).toBe(nuevoValor);
    expect(despues!.calculadoEn).not.toBe(antes!.calculadoEn);
  });
});
