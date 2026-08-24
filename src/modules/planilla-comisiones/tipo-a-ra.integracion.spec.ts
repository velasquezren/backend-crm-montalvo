import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AnaliticaComisionesService } from './analitica-comisiones.service';
import { CalculoComisionesService } from './calculo-comisiones.service';
import { ConfiguracionComisionesService } from './configuracion-comisiones.service';

/**
 * El cubo "Tipo A (RA)": comisión por NIVELES sobre ventas del área RA que no
 * son cirugía (consulta, laboratorio, ecografía, otros), aparte de la de
 * planes de maternidad y de la de cirugías.
 *
 * No lo cubre `verificacion-diciembre`: los tres Excel de referencia
 * (octubre/noviembre/diciembre 2025) vienen en el formato viejo de FileMaker
 * (20 columnas), que no trae columna `AREA` — así que ninguna fila de esos
 * meses puede clasificarse como `UnidadNegocio.RA` salvo por el diccionario
 * (que hoy solo cubre procedimientos, todos Tipo B). El camino de código
 * existe y se ejercita de verdad recién con exports que sí traen `AREA`
 * (`2026 EXCELS/enero.xlsx`). Aquí se siembra directo, como hace
 * `foto-configuracion.integracion.spec.ts`.
 *
 * Reglas verificadas contra `CALCULO COMISION DICIEMBRE 2025.xlsx`
 * (`BDEjecutivas`, columnas AT-BD): el nivel sale del excedente de
 * (ingreso de planes + ingreso RA no-cirugía) sobre el objetivo mensual en $,
 * y el % de ese nivel se cobra solo sobre la porción RA.
 */

const URL_TEST =
  process.env['DATABASE_URL_TEST'] ??
  'postgresql://crm_app:crm_dev_local@localhost:5433/crm_test?schema=public';

if (!URL_TEST.includes('/crm_test')) {
  throw new Error('La suite de integración solo puede correr contra la base crm_test');
}

const prisma = new PrismaService({ datasources: { db: { url: URL_TEST } } });

let calculo: CalculoComisionesService;
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

  const configuracion = new ConfiguracionComisionesService(prisma);
  await configuracion.asegurarConfiguracion();

  calculo = new CalculoComisionesService(
    prisma,
    configuracion,
    new AuditService(prisma),
    new AnaliticaComisionesService(prisma),
    { invalidar: () => undefined } as never,
  );
  jest.spyOn(calculo['logger'], 'warn').mockImplementation(() => undefined);
  jest.spyOn(calculo['logger'], 'log').mockImplementation(() => undefined);

  const periodo = await prisma.periodoComision.create({
    data: { anio: 2026, mes: 6, tipoCambio: 6.97 },
  });
  periodoId = periodo.id;
});

/** VENDEDORA con objetivo mensual por defecto: 12.000 USD. */
async function vendedora(codigo: string) {
  return prisma.vendedoraComision.create({
    data: { codigo, nombre: `Vendedora ${codigo}`, configurada: true, sueldoBase: 2750, tipo: 'VENDEDORA' },
  });
}

async function venta(data: {
  vendedoraId: string;
  clasif: 'PLANPAQ' | 'CONSULTA' | 'CIRUGIA' | 'CAMPANA';
  unidadNegocio: 'MATERNIDAD' | 'RA';
  canal: 'EMPRESA' | 'PROPIO';
  ingresoNeto: number;
  nivel?: 'GOLD' | 'SILVER' | 'BRONCE';
}) {
  return prisma.ventaImportada.create({
    data: {
      periodoId,
      vendedoraId: data.vendedoraId,
      detalle: data.clasif,
      precio: data.ingresoNeto / 0.87,
      canal: data.canal,
      ingresoNeto: data.ingresoNeto,
      unidadNegocio: data.unidadNegocio,
      clasif: data.clasif,
      nivel: data.nivel,
      tipo: data.clasif === 'CIRUGIA' ? 'B' : data.clasif === 'PLANPAQ' ? 'A' : 'C',
      comisionable: true,
    },
  });
}

async function resultado(vendedoraId: string) {
  return prisma.resultadoComision.findUniqueOrThrow({
    where: { periodoId_vendedoraId: { periodoId, vendedoraId } },
  });
}

describe('Tipo A (RA): nivel por excedente combinado, comisión solo sobre la porción RA', () => {
  it('supera el objetivo con planes + RA → nivel 1, y solo la porción RA cobra', async () => {
    const v = await vendedora('Pe-ra-1');
    // 13.000 (planes) + 500 (RA consulta) = 13.500 → excedente 1.500 sobre 12.000 → NIVEL 1.
    await venta({ vendedoraId: v.id, clasif: 'PLANPAQ', unidadNegocio: 'MATERNIDAD', canal: 'EMPRESA', ingresoNeto: 13000, nivel: 'GOLD' });
    await venta({ vendedoraId: v.id, clasif: 'CONSULTA', unidadNegocio: 'RA', canal: 'EMPRESA', ingresoNeto: 500 });

    await calculo.calcular(periodoId, 'test');
    const r = await resultado(v.id);

    expect(r.nivelTipoARA).toBe(1);
    // NIVEL 1 empresa = 1% sobre los 500 de la porción RA, no sobre los 13.500 combinados.
    expect(Number(r.comisionTipoARA)).toBeCloseTo(5.0, 2);
    // Los dos sumandos que arman el excedente, guardados por separado — sin
    // esto el reporte solo podía mostrar "1.500 de excedente" sin decir de
    // dónde salió cada parte.
    expect(Number(r.ingresoMaternidadTipoARA)).toBeCloseTo(13000, 2);
    expect(Number(r.ingresoRATipoARA)).toBeCloseTo(500, 2);
    expect(Number(r.excedenteTipoARA)).toBeCloseTo(1500, 2);
  });

  it('canal PROPIO cobra la tarifa propia del nivel, no la de empresa', async () => {
    const v = await vendedora('Pe-ra-2');
    await venta({ vendedoraId: v.id, clasif: 'PLANPAQ', unidadNegocio: 'MATERNIDAD', canal: 'PROPIO', ingresoNeto: 13000, nivel: 'GOLD' });
    await venta({ vendedoraId: v.id, clasif: 'CONSULTA', unidadNegocio: 'RA', canal: 'PROPIO', ingresoNeto: 500 });

    await calculo.calcular(periodoId, 'test');
    const r = await resultado(v.id);

    expect(r.nivelTipoARA).toBe(1);
    // NIVEL 1 propio = 1,5 %.
    expect(Number(r.comisionTipoARA)).toBeCloseTo(7.5, 2);
    // El canal cambia la tarifa, no los ingresos que arman el excedente.
    expect(Number(r.ingresoMaternidadTipoARA)).toBeCloseTo(13000, 2);
    expect(Number(r.ingresoRATipoARA)).toBeCloseTo(500, 2);
    expect(Number(r.excedenteTipoARA)).toBeCloseTo(1500, 2);
  });

  it('no supera el objetivo combinado → NA → cero, aunque haya ventas RA', async () => {
    const v = await vendedora('Pe-ra-3');
    // 5.000 + 500 = 5.500, muy por debajo de los 12.000 de objetivo.
    await venta({ vendedoraId: v.id, clasif: 'PLANPAQ', unidadNegocio: 'MATERNIDAD', canal: 'EMPRESA', ingresoNeto: 5000, nivel: 'GOLD' });
    await venta({ vendedoraId: v.id, clasif: 'CONSULTA', unidadNegocio: 'RA', canal: 'EMPRESA', ingresoNeto: 500 });

    await calculo.calcular(periodoId, 'test');
    const r = await resultado(v.id);

    expect(r.nivelTipoARA).toBeNull();
    expect(Number(r.comisionTipoARA)).toBe(0);
    // El excedente queda NEGATIVO y se guarda tal cual — no se recorta a
    // cero — para que el reporte pueda decir "le faltaron 6.500" en vez de
    // un "0" que no distingue "justo en el objetivo" de "lejísimos".
    expect(Number(r.ingresoMaternidadTipoARA)).toBeCloseTo(5000, 2);
    expect(Number(r.ingresoRATipoARA)).toBeCloseTo(500, 2);
    expect(Number(r.excedenteTipoARA)).toBeCloseTo(-6500, 2);
  });

  it('supera el objetivo solo con planes (sin ventas RA) → nivel, pero cero comisión RA', async () => {
    // Es justo lo que pasó en diciembre 2025 real con Yelca: el nivel se
    // desbloquea con planes solos, pero sin ingreso RA no hay nada que pagar.
    const v = await vendedora('Pe-ra-4');
    await venta({ vendedoraId: v.id, clasif: 'PLANPAQ', unidadNegocio: 'MATERNIDAD', canal: 'EMPRESA', ingresoNeto: 13500, nivel: 'GOLD' });

    await calculo.calcular(periodoId, 'test');
    const r = await resultado(v.id);

    expect(r.nivelTipoARA).toBe(1);
    expect(Number(r.comisionTipoARA)).toBe(0);
    // El caso que el reporte tiene que dejar claro sin ambigüedad: hay nivel
    // (por los planes) pero CERO ingreso RA, así que no hay nada que cobrar.
    expect(Number(r.ingresoMaternidadTipoARA)).toBeCloseTo(13500, 2);
    expect(Number(r.ingresoRATipoARA)).toBe(0);
    expect(Number(r.excedenteTipoARA)).toBeCloseTo(1500, 2);
  });

  it('la cirugía del área RA va al pool de Tipo B, no a Tipo A (RA)', async () => {
    const v = await vendedora('Pe-ra-5');
    await venta({ vendedoraId: v.id, clasif: 'PLANPAQ', unidadNegocio: 'MATERNIDAD', canal: 'EMPRESA', ingresoNeto: 13000, nivel: 'GOLD' });
    await venta({ vendedoraId: v.id, clasif: 'CONSULTA', unidadNegocio: 'RA', canal: 'EMPRESA', ingresoNeto: 500 });
    await venta({ vendedoraId: v.id, clasif: 'CIRUGIA', unidadNegocio: 'RA', canal: 'EMPRESA', ingresoNeto: 2000 });

    await calculo.calcular(periodoId, 'test');
    const r = await resultado(v.id);

    // El nivel de Tipo A (RA) no se mueve por la cirugía: sigue siendo NIVEL 1
    // (excedente 1.500, igual que sin la fila de cirugía) y la comisión RA
    // sigue siendo solo sobre los 500 de consulta.
    expect(r.nivelTipoARA).toBe(1);
    expect(Number(r.comisionTipoARA)).toBeCloseTo(5.0, 2);
    // La cirugía sí generó comisión Tipo B, por su propia escala (NA: 2.000 < 5.000 → NIVEL 1 → 1%).
    expect(Number(r.comisionB)).toBeCloseTo(20.0, 2);
    // Los 2.000 de cirugía NO entran a `ingresoRATipoARA`: ya están en el
    // pool de Tipo B, que es lo que este test verifica en `comisionB`.
    expect(Number(r.ingresoMaternidadTipoARA)).toBeCloseTo(13000, 2);
    expect(Number(r.ingresoRATipoARA)).toBeCloseTo(500, 2);
    expect(Number(r.excedenteTipoARA)).toBeCloseTo(1500, 2);
  });

  it('campaña y promoción del área RA no comisionan, ni suman al excedente', async () => {
    const v = await vendedora('Pe-ra-6');
    await venta({ vendedoraId: v.id, clasif: 'PLANPAQ', unidadNegocio: 'MATERNIDAD', canal: 'EMPRESA', ingresoNeto: 13000, nivel: 'GOLD' });
    await venta({ vendedoraId: v.id, clasif: 'CAMPANA', unidadNegocio: 'RA', canal: 'EMPRESA', ingresoNeto: 900 });

    await calculo.calcular(periodoId, 'test');
    const r = await resultado(v.id);

    // Sin la campaña sumando: excedente 1.000 exacto → todavía NIVEL 1 (el
    // límite de NA es < 1.000, así que 1.000 justo entra al nivel 1).
    expect(r.nivelTipoARA).toBe(1);
    expect(Number(r.comisionTipoARA)).toBe(0);
    expect(Number(r.comisionC)).toBe(0); // Campaña del área RA paga 0 también en Tipo C.
    // Los 900 de campaña quedan fuera de `ingresoRATipoARA`: si entraran, el
    // excedente sería 1.900 y no 1.000.
    expect(Number(r.ingresoMaternidadTipoARA)).toBeCloseTo(13000, 2);
    expect(Number(r.ingresoRATipoARA)).toBe(0);
    expect(Number(r.excedenteTipoARA)).toBeCloseTo(1000, 2);
  });
});
