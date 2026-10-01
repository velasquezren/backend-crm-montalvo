import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TipoCambioService } from '../tipo-cambio/tipo-cambio.service';
import { CategoriaPacienteService } from './categoria-paciente.service';

/**
 * La categoría por valor contra PostgreSQL real: lo que se prueba es el SQL
 * que agrega las dos fuentes (FileMaker por PAC, CRM por ficha), la ventana de
 * 12 meses y que una categoría fijada a mano no se toque.
 */

const URL_TEST = 'postgresql://crm_app:crm_dev_local@localhost:5433/crm_test?schema=public';
if (!URL_TEST.includes('/crm_test')) {
  throw new Error('La suite de integración solo puede correr contra la base crm_test');
}

const prisma = new PrismaService(URL_TEST);
const audit = new AuditService(prisma);
const tipoCambio = new TipoCambioService(prisma, audit);
const service = new CategoriaPacienteService(prisma, audit, tipoCambio);

const AHORA = new Date('2026-09-30T12:00:00.000Z');
const HACE_UN_MES = new Date('2026-08-30T12:00:00.000Z');
const HACE_DOS_ANIOS = new Date('2024-09-30T12:00:00.000Z');

let periodoId: string;
let agenteId: string;
let n = 0;

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.auditLog.deleteMany();
  await prisma.ventaImportada.deleteMany();
  await prisma.periodoComision.deleteMany();
  await prisma.venta.deleteMany();
  await prisma.cliente.deleteMany();
  await prisma.usuario.deleteMany();
  periodoId = (await prisma.periodoComision.create({ data: { anio: 2026, mes: 8, tipoCambio: 6.97 } })).id;
  agenteId = (await prisma.usuario.create({ data: { nombre: 'Agente', email: 'agente@test.local', passwordHash: 'x' } })).id;
});

async function paciente(pac: string | null = null) {
  n += 1;
  return prisma.cliente.create({ data: { nombre: `Paciente ${n}`, telefono: `+5917000${String(n).padStart(4, '0')}`, pac } });
}

/** Una línea de la planilla de FileMaker, en dólares, tal como se importa. */
async function filemaker(pac: string, precio: number, fecha: Date | null = HACE_UN_MES) {
  await prisma.ventaImportada.create({
    data: {
      periodoId, pac, precio, fecha, detalle: 'Servicio', paciente: 'Paciente',
      canal: 'PROPIO', ingresoNeto: precio * 0.87, unidadNegocio: 'VARIOS', clasif: 'CONSULTA', tipo: 'A',
    },
  });
}

const categoriaDe = async (id: string) => (await prisma.cliente.findUniqueOrThrow({ where: { id } })).categoria;

describe('categoría por valor', () => {
  it('sale del gasto de FileMaker en los últimos 12 meses', async () => {
    const gold = await paciente('PAC1');
    const silver = await paciente('PAC2');
    const bronze = await paciente('PAC3');
    const antigua = await paciente('PAC4');
    const sinCompras = await paciente('PAC5');
    await filemaker('PAC1', 2_000);
    await filemaker('PAC1', 1_600);
    await filemaker('PAC2', 1_200);
    await filemaker('PAC3', 300);
    await filemaker('PAC4', 9_000, HACE_DOS_ANIOS);

    expect(await service.recalcular(undefined, prisma, AHORA)).toBe(4);
    expect(await categoriaDe(gold.id)).toBe('GOLD');
    expect(await categoriaDe(silver.id)).toBe('SILVER');
    expect(await categoriaDe(bronze.id)).toBe('BRONZE');
    /* Fue Gold hace dos años: hoy es Bronze, no Gold para siempre. */
    expect(await categoriaDe(antigua.id)).toBe('BRONZE');
    expect(await categoriaDe(sinCompras.id)).toBe('PROSPECTO');
    /* Repetirlo no cambia nada. */
    expect(await service.recalcular(undefined, prisma, AHORA)).toBe(0);
  });

  it('suma FileMaker y el CRM, pasando los bolivianos a dólares', async () => {
    const { tipoCambio: tc } = await tipoCambio.vigente();
    const mixta = await paciente('PAC10');
    await filemaker('PAC10', 800);
    await prisma.venta.create({ data: { clienteId: mixta.id, agenteId, producto: 'Botox', monto: 250 * tc, createdAt: HACE_UN_MES } });
    await prisma.venta.create({ data: { clienteId: mixta.id, agenteId, producto: 'Anulada', monto: 50_000, estado: 'PERDIDA' } });

    await service.recalcular(mixta.id, prisma, AHORA);
    /* $800 + $250 = $1.050: Silver. La venta perdida no cuenta. */
    expect(await categoriaDe(mixta.id)).toBe('SILVER');
  });

  it('una línea sin precio no es una compra', async () => {
    const cortesia = await paciente('PAC20');
    await filemaker('PAC20', 0);
    await service.recalcular(cortesia.id, prisma, AHORA);
    expect(await categoriaDe(cortesia.id)).toBe('PROSPECTO');
  });

  /* Clientes ordena por `updatedAt`: recalcular no es editar. */
  it('recalcular no mueve la fecha de edición de la ficha', async () => {
    const p = await paciente('PAC30');
    await filemaker('PAC30', 5_000);
    await service.recalcular(p.id, prisma, AHORA);
    expect((await prisma.cliente.findUniqueOrThrow({ where: { id: p.id } })).updatedAt).toEqual(p.updatedAt);
  });
});

describe('categoría fijada a mano', () => {
  it('el cálculo no la toca, y al volver a automática se recalcula en el acto', async () => {
    const super_ = await prisma.usuario.create({ data: { nombre: 'Dueño', email: 'super@test.local', passwordHash: 'x', rol: 'SUPER_ADMIN' } });
    const vip = await paciente('PAC40');
    await filemaker('PAC40', 1_500);

    const fijada = await service.fijar(vip.id, 'GOLD', super_.id);
    expect(fijada).toMatchObject({ categoria: 'GOLD', categoriaFijadaPor: { id: super_.id } });
    expect(await service.recalcular(undefined, prisma, AHORA)).toBe(0);
    expect(await categoriaDe(vip.id)).toBe('GOLD');

    const automatica = await service.fijar(vip.id, null, super_.id);
    expect(automatica).toMatchObject({ categoria: 'SILVER', categoriaFijadaEn: null, categoriaFijadaPor: null });
    expect(await prisma.auditLog.findMany({ where: { entidadId: vip.id }, select: { accion: true }, orderBy: { createdAt: 'asc' } }))
      .toEqual([{ accion: 'CATEGORIA_FIJADA' }, { accion: 'CATEGORIA_AUTOMATICA' }]);
  });
});
