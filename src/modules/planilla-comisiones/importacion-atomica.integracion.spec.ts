import * as XLSX from 'xlsx';

import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TipoCambioService } from '../tipo-cambio/tipo-cambio.service';
import { CatalogoClinicoService } from './catalogo-clinico.service';
import { ConfiguracionComisionesService } from './configuracion-comisiones.service';
import { PlanillaComisionesService } from './planilla-comisiones.service';
import { ResumenAnualService } from './resumen-anual.service';

const URL_TEST = process.env['DATABASE_URL_TEST'] ??
  'postgresql://crm_app:crm_dev_local@127.0.0.1:5433/crm_test?schema=public';
const destino = new URL(URL_TEST);
if (destino.pathname !== '/crm_test' || !['localhost', '127.0.0.1', '[::1]'].includes(destino.hostname)) {
  throw new Error('Esta suite solo puede ejecutarse contra crm_test en loopback');
}

const prisma = new PrismaService(URL_TEST);
const configuracion = new ConfiguracionComisionesService(prisma);
const audit = new AuditService(prisma);
const catalogo = new CatalogoClinicoService(prisma);
const anual = new ResumenAnualService(prisma, configuracion);
const planilla = new PlanillaComisionesService(
  prisma, configuracion, audit, catalogo, anual, new TipoCambioService(prisma, audit),
);
const PERIODO = { anio: 2031, mes: 1, tipoCambio: 6.97 };

/** Excel real de prueba, sin datos de pacientes. La fila 501 dispara el fallo SQL. */
function excel(cantidad: number, version: string, control?: 'fallar' | 'pausar'): Buffer {
  const filas = Array.from({ length: cantidad }, (_, i) => ({
    FECHA: '2031-01-10',
    MODULO: 'CONSULTA',
    DETALLE: 'Consulta F02',
    COD_ORIGEN: i === 0 ? 'F02-COMPARTIDA' : `F02-${version}-${i}`,
    PAC: 'PAC-F02',
    PACIENTE: 'Paciente ficticio F02',
    PRECIO: version === 'anterior' ? 100 : 200,
    VENDEDORA_PK: 'F02-V',
    VENDEDORA: 'Vendedora ficticia F02',
    MEDICO_PK: 'F02-M',
    MEDICO: `Medico ficticio ${version}`,
    OBS: control && i === cantidad - 1 ? (control === 'fallar' ? 'F02_FALLAR' : 'F02_PAUSAR') : version,
    TC: 6.97,
  }));
  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(filas), 'Ventas');
  return XLSX.write(libro, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

async function fotoPeriodo(id: string) {
  return prisma.periodoComision.findUniqueOrThrow({
    where: { id },
    include: {
      ventas: { orderBy: { id: 'asc' } },
      resultados: { orderBy: { id: 'asc' } },
    },
  });
}

beforeAll(async () => {
  await prisma.$connect();
  await configuracion.asegurarConfiguracion();

  // El fallo ocurre en PostgreSQL, no en un mock de createMany/$transaction.
  // El conteo dentro del trigger acredita que el primer lote ya se insertó.
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION f02_fallar_lote() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE insertadas integer;
    BEGIN
      IF NEW.obs = 'F02_FALLAR' THEN
        SELECT count(*) INTO insertadas FROM "VentaImportada" WHERE "periodoId" = NEW."periodoId";
        RAISE EXCEPTION 'F02: fallo posterior a % filas', insertadas;
      END IF;
      IF NEW.obs = 'F02_PAUSAR' THEN
        PERFORM pg_advisory_xact_lock(202603, 1);
      END IF;
      RETURN NEW;
    END $$
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER f02_fallar_lote BEFORE INSERT ON "VentaImportada"
    FOR EACH ROW EXECUTE FUNCTION f02_fallar_lote()
  `);
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION f02_fallar_final() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE insertadas integer;
    BEGIN
      IF NEW."archivoNombre" = 'F02_FIN.xlsx' THEN
        SELECT count(*) INTO insertadas FROM "VentaImportada" WHERE "periodoId" = NEW.id;
        RAISE EXCEPTION 'F02: fallo final posterior a % filas', insertadas;
      END IF;
      RETURN NEW;
    END $$
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER f02_fallar_final BEFORE UPDATE OF "filasValidas" ON "PeriodoComision"
    FOR EACH ROW EXECUTE FUNCTION f02_fallar_final()
  `);
}, 30_000);

beforeEach(async () => {
  jest.spyOn(planilla['logger'], 'log').mockImplementation(() => undefined);
  jest.spyOn(planilla['logger'], 'warn').mockImplementation(() => undefined);
  await prisma.periodoComision.deleteMany({ where: { anio: PERIODO.anio } });
  await prisma.vendedoraComision.deleteMany({ where: { codigo: { startsWith: 'F02-' } } });
  await prisma.medico.deleteMany({ where: { codigo: { startsWith: 'F02-' } } });
});

afterEach(() => jest.restoreAllMocks());

afterAll(async () => {
  await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS f02_fallar_lote ON "VentaImportada"');
  await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS f02_fallar_lote()');
  await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS f02_fallar_final ON "PeriodoComision"');
  await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS f02_fallar_final()');
  await prisma.periodoComision.deleteMany({ where: { anio: PERIODO.anio } });
  await prisma.vendedoraComision.deleteMany({ where: { codigo: { startsWith: 'F02-' } } });
  await prisma.medico.deleteMany({ where: { codigo: { startsWith: 'F02-' } } });
  await prisma.auditLog.deleteMany({ where: { usuarioId: 'F02-test' } });
  await prisma.$disconnect();
});

async function importarAnteriorCalculada() {
  const { periodo } = await planilla.importar(excel(2, 'anterior'), 'anterior.xlsx', PERIODO, 'F02-test');
  const vendedora = await prisma.vendedoraComision.findUniqueOrThrow({ where: { codigo: 'F02-V' } });
  await prisma.ventaImportada.updateMany({
    where: { periodoId: periodo.id, codOrigen: 'F02-COMPARTIDA' },
    data: { ajustadaManual: true, canal: 'PROPIO', comisionable: false, requiereRevision: false },
  });
  await prisma.resultadoComision.create({
    data: { periodoId: periodo.id, vendedoraId: vendedora.id, totalBob: 123.45, desglose: { fixture: 'anterior' } },
  });
  await prisma.periodoComision.update({
    where: { id: periodo.id },
    data: { estado: 'CALCULADO', calculadoEn: new Date('2031-01-31T12:00:00Z'), configuracionUsada: { fixture: 'anterior' } },
  });
  return fotoPeriodo(periodo.id);
}

it('conserva íntegra la importación anterior si falla un lote posterior', async () => {
  const anterior = await importarAnteriorCalculada();
  const medicos = await prisma.medico.findMany({ where: { codigo: 'F02-M' } });
  const vendedoras = await prisma.vendedoraComision.findMany({ where: { codigo: 'F02-V' } });
  const auditorias = await prisma.auditLog.count({ where: { entidadId: anterior.id } });
  const invalidarCatalogo = jest.spyOn(catalogo, 'invalidar');
  const invalidarAnual = jest.spyOn(anual, 'invalidar');

  await expect(planilla.importar(excel(501, 'nueva', 'fallar'), 'nueva.xlsx', {
    ...PERIODO, tipoCambio: 7,
  }, 'F02-test')).rejects.toThrow('F02: fallo posterior a 500 filas');

  // Incluye IDs, importadoPor, archivo, contadores, TC, estado, timestamps,
  // clasificación manual, configuración fotografiada y resultados anteriores.
  expect(await fotoPeriodo(anterior.id)).toEqual(anterior);
  expect(await prisma.ventaImportada.count({ where: { periodoId: anterior.id, obs: 'nueva' } })).toBe(0);
  expect(await prisma.medico.findMany({ where: { codigo: 'F02-M' } })).toEqual(medicos);
  expect(await prisma.vendedoraComision.findMany({ where: { codigo: 'F02-V' } })).toEqual(vendedoras);
  expect(await prisma.auditLog.count({ where: { entidadId: anterior.id } })).toBe(auditorias);
  expect(invalidarCatalogo).not.toHaveBeenCalled();
  expect(invalidarAnual).not.toHaveBeenCalled();
});

it('sustituye todos los lotes, conserva ajustes y no toca otro periodo', async () => {
  const anterior = await importarAnteriorCalculada();
  const otro = await planilla.importar(excel(2, 'otro'), 'otro.xlsx', { ...PERIODO, mes: 2 }, 'F02-test');
  const otroAntes = await fotoPeriodo(otro.periodo.id);

  const respuesta = await planilla.importar(excel(501, 'nueva'), 'nueva.xlsx', PERIODO, 'F02-test');
  const nuevo = await fotoPeriodo(anterior.id);
  expect(respuesta.periodo.id).toBe(anterior.id);
  expect(nuevo).toMatchObject({ archivoNombre: 'nueva.xlsx', filasTotales: 501, filasValidas: 501, estado: 'BORRADOR', calculadoEn: null });
  expect(nuevo.ventas).toHaveLength(501);
  expect(nuevo.resultados).toEqual([]);
  expect(nuevo.ventas.every(v => v.obs === 'nueva')).toBe(true);
  expect(nuevo.ventas.some(v => anterior.ventas.some(a => a.id === v.id))).toBe(false);
  expect(nuevo.ventas.find(v => v.codOrigen === 'F02-COMPARTIDA')).toMatchObject({
    ajustadaManual: true, canal: 'PROPIO', comisionable: false, requiereRevision: false,
  });
  // El resumen conserva el criterio anterior: cuenta el clasificador antes del ajuste.
  expect(respuesta.resumen).toMatchObject({ filasLeidas: 501, filasComisionables: 501, ajustesConservados: 1, vendedorasDetectadas: 1 });
  expect(await fotoPeriodo(otro.periodo.id)).toEqual(otroAntes);
});

it('un fallo en la primera importación tampoco deja periodo ni altas parciales', async () => {
  await expect(planilla.importar(excel(501, 'nueva', 'fallar'), 'nueva.xlsx', PERIODO, 'F02-test'))
    .rejects.toThrow('F02: fallo posterior a 500 filas');
  expect(await prisma.periodoComision.count({ where: { anio: PERIODO.anio } })).toBe(0);
  expect(await prisma.ventaImportada.count({ where: { pac: 'PAC-F02' } })).toBe(0);
  expect(await prisma.vendedoraComision.count({ where: { codigo: 'F02-V' } })).toBe(0);
  expect(await prisma.medico.count({ where: { codigo: 'F02-M' } })).toBe(0);

  // El bloqueo transaccional también se libera tras rollback.
  await expect(planilla.importar(excel(2, 'reintento'), 'reintento.xlsx', PERIODO, 'F02-test'))
    .resolves.toMatchObject({ periodo: { filasTotales: 2 } });
});

it('revierte todos los lotes si falla la actualización final del periodo', async () => {
  const anterior = await importarAnteriorCalculada();
  await expect(planilla.importar(excel(501, 'nueva'), 'F02_FIN.xlsx', PERIODO, 'F02-test'))
    .rejects.toThrow('F02: fallo final posterior a 501 filas');
  expect(await fotoPeriodo(anterior.id)).toEqual(anterior);
});

it('un archivo inválido conserva la versión anterior', async () => {
  const anterior = await importarAnteriorCalculada();
  await expect(planilla.importar(Buffer.from('sin columnas de Excel'), 'invalido.xlsx', PERIODO, 'F02-test'))
    .rejects.toThrow();
  expect(await fotoPeriodo(anterior.id)).toEqual(anterior);
});

it.each(['EN_REVISION', 'CERRADO', 'PAGADO'] as const)('sigue rechazando reimportar un periodo %s', async estado => {
  const anterior = await importarAnteriorCalculada();
  await prisma.periodoComision.update({ where: { id: anterior.id }, data: { estado } });
  const bloqueado = await fotoPeriodo(anterior.id);
  await expect(planilla.importar(excel(2, 'nueva'), 'nueva.xlsx', PERIODO, 'F02-test'))
    .rejects.toMatchObject({ status: 409 });
  expect(await fotoPeriodo(anterior.id)).toEqual(bloqueado);
});

/** Espera una condición observable del servidor, no un orden supuesto de promesas. */
async function esperarLotePausado() {
  for (let intento = 0; intento < 200; intento++) {
    const [estado] = await prisma.$queryRaw<Array<{ esperando: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM pg_locks WHERE locktype = 'advisory'
          AND classid = 202603 AND objid = 1 AND NOT granted
      ) AS esperando
    `;
    if (estado.esperando) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('La importación no alcanzó la barrera SQL del segundo lote');
}

it.each([false, true])('dos administradores no mezclan importaciones (periodo previo: %s)', async existe => {
  const anterior = existe ? await importarAnteriorCalculada() : null;
  let liberar = () => {};
  let avisar = () => {};
  const retenido = new Promise<void>(resolve => { liberar = resolve; });
  const listo = new Promise<void>(resolve => { avisar = resolve; });
  // Una conexión retiene la barrera; otra publica y una tercera observa/compite.
  const barrera = prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(202603, 1)`;
    avisar();
    await retenido;
  }, { timeout: 15_000 });
  await listo;
  const primera = planilla.importar(excel(501, 'primera', 'pausar'), 'primera.xlsx', PERIODO, 'F02-test');
  // Se espera en finally incluso si falla una aserción mientras está bloqueada.
  void primera.catch(() => undefined);
  try {
    await esperarLotePausado();
    if (anterior) expect(await fotoPeriodo(anterior.id)).toEqual(anterior);
    else expect(await prisma.periodoComision.count({ where: { anio: PERIODO.anio } })).toBe(0);
    await expect(planilla.importar(excel(502, 'segunda'), 'segunda.xlsx', PERIODO, 'F02-test'))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining('en curso') });
  } finally {
    liberar();
    await barrera;
    await primera;
  }
  const publicada = (await primera).periodo;
  expect(await prisma.ventaImportada.count({ where: { periodoId: publicada.id } })).toBe(501);
  const segunda = await planilla.importar(excel(502, 'segunda'), 'segunda.xlsx', PERIODO, 'F02-test');
  expect(segunda.periodo.id).toBe(publicada.id);
  expect(await prisma.ventaImportada.count({ where: { periodoId: publicada.id } })).toBe(502);
  expect(await prisma.ventaImportada.count({ where: { periodoId: publicada.id, obs: { not: 'segunda' } } })).toBe(0);
}, 20_000);
