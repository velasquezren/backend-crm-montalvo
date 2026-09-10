import { ConflictException } from '@nestjs/common';
import * as XLSX from 'xlsx';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '../../prisma/prisma-client';
import { TipoCambioService } from '../tipo-cambio/tipo-cambio.service';
import { AnaliticaComisionesService } from './analitica-comisiones.service';
import { CalculoComisionesService } from './calculo-comisiones.service';
import { CatalogoClinicoService } from './catalogo-clinico.service';
import { ConfiguracionComisionesService } from './configuracion-comisiones.service';
import { PlanillaComisionesService } from './planilla-comisiones.service';
import { ResumenAnualService } from './resumen-anual.service';
import { bloquearPeriodo, transaccionFinanciera } from './transaccion-periodo';
import { ReglaDiccionario } from './clasificador';

const url = process.env['DATABASE_URL_TEST'] ?? 'postgresql://crm_app:crm_dev_local@127.0.0.1:5433/crm_test';
const destino = new URL(url);
if (destino.pathname !== '/crm_test' || !['127.0.0.1', 'localhost', '[::1]'].includes(destino.hostname)) {
  throw new Error('F03 solo se ejecuta contra crm_test en loopback');
}
const prisma = new PrismaService(url);
const config = new ConfiguracionComisionesService(prisma);
const audit = new AuditService(prisma);
const anual = new ResumenAnualService(prisma, config);
/* La MISMA instancia que recibe el motor: la caché vive en el objeto, así que
   dos instancias distintas harían pasar una prueba de invalidación que en
   producción no se cumpliría. */
const analitica = new AnaliticaComisionesService(prisma);
const calculo = new CalculoComisionesService(prisma, config, audit, analitica, anual);
const planilla = new PlanillaComisionesService(prisma, config, audit, new CatalogoClinicoService(prisma), anual, analitica, new TipoCambioService(prisma, audit));
let periodoId: string;
let ventaId: string;
let administradores: string[];

function barrera() {
  let liberar = () => {};
  let avisar = () => {};
  const llegada = new Promise<void>(resolve => { avisar = resolve; });
  const espera = new Promise<void>(resolve => { liberar = resolve; });
  return { llegada, liberar, async pausar() { avisar(); await espera; } };
}

async function foto() {
  const periodo = await prisma.periodoComision.findUniqueOrThrow({
    where: { id: periodoId },
    include: { ventas: { orderBy: { id: 'asc' } }, resultados: { orderBy: { id: 'asc' } }, aprobaciones: { orderBy: { usuarioId: 'asc' } }, objetivos: { orderBy: { id: 'asc' } } },
  });
  const auditoria = await prisma.auditLog.findMany({ where: { entidadId: { in: [periodoId, ventaId] } }, orderBy: { id: 'asc' } });
  return { periodo, auditoria };
}

async function cerrar() {
  await planilla.enviarARevision(periodoId, administradores[0]);
  for (const usuario of administradores) await planilla.aprobar(periodoId, usuario);
}

beforeAll(async () => {
  await prisma.$connect();
  await config.asegurarConfiguracion();
  await prisma.$executeRawUnsafe('CREATE TABLE f03_fallos_audit (accion text PRIMARY KEY)');
  await prisma.$executeRawUnsafe(`CREATE FUNCTION f03_auditoria_falla() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF (NEW.accion = 'REABRIR' AND NEW.cambios->>'motivo' = 'F03_FALLO_AUDITORIA')
        OR EXISTS (SELECT 1 FROM f03_fallos_audit WHERE accion = NEW.accion) THEN
        RAISE EXCEPTION 'F03: auditoria obligatoria fallida';
      END IF;
      RETURN NEW;
    END $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER f03_auditoria_falla BEFORE INSERT ON "AuditLog"
    FOR EACH ROW EXECUTE FUNCTION f03_auditoria_falla()`);
}, 30_000);

beforeEach(async () => {
  jest.spyOn(calculo['logger'], 'log').mockImplementation(() => undefined);
  jest.spyOn(calculo['logger'], 'warn').mockImplementation(() => undefined);
  await prisma.$executeRawUnsafe('DELETE FROM f03_fallos_audit');
  if (administradores) await prisma.auditLog.deleteMany({ where: { usuarioId: { in: administradores } } });
  await prisma.periodoComision.deleteMany({ where: { anio: 2032 } });
  await prisma.vendedoraComision.deleteMany({ where: { codigo: 'F03-V' } });
  await prisma.usuario.deleteMany({ where: { email: { endsWith: '@f03.test' } } });
  administradores = [];
  for (const nombre of ['Ana', 'Beto']) {
    const usuario = await prisma.usuario.create({ data: { nombre, email: `${nombre}@f03.test`, passwordHash: 'fixture', rol: 'SUPER_ADMIN' } });
    administradores.push(usuario.id);
  }
  const periodo = await prisma.periodoComision.create({ data: { anio: 2032, mes: 1, tipoCambio: 6.97 } });
  periodoId = periodo.id;
  const vendedora = await prisma.vendedoraComision.create({ data: { codigo: 'F03-V', nombre: 'Vendedora F03', configurada: true } });
  const venta = await prisma.ventaImportada.create({ data: {
    periodoId, vendedoraId: vendedora.id, detalle: 'Consulta F03', precio: 1000, ingresoNeto: 870,
    canal: 'EMPRESA', unidadNegocio: 'VARIOS', clasif: 'CONSULTA', tipo: 'C',
  } });
  ventaId = venta.id;
  await calculo.calcular(periodoId, administradores[0]);
});

afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS f03_auditoria_falla ON "AuditLog"');
  await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS f03_auditoria_falla()');
  await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS f03_fallos_audit');
  await prisma.periodoComision.deleteMany({ where: { anio: 2032 } });
  await prisma.vendedoraComision.deleteMany({ where: { codigo: 'F03-V' } });
  await prisma.auditLog.deleteMany({ where: { usuarioId: { in: administradores ?? [] } } });
  await prisma.usuario.deleteMany({ where: { email: { endsWith: '@f03.test' } } });
  await prisma.$disconnect();
});

it('A: pagar y reabrir concurrentes no pueden confirmar ambos', async () => {
  await cerrar();
  const pausa = barrera();
  const obtener = planilla.obtenerPeriodo.bind(planilla);
  // Lectura real, después una barrera: en el código anterior ambos leen CERRADO.
  jest.spyOn(planilla, 'obtenerPeriodo').mockImplementationOnce(async (...args) => {
    const periodo = await obtener(...args);
    expect(periodo.estado).toBe('CERRADO');
    await pausa.pausar();
    return periodo;
  });
  const reabrir = planilla.reabrir(periodoId, administradores[0], 'Corrección de archivo');
  void reabrir.catch(() => undefined);
  await pausa.llegada;
  const pago = await Promise.allSettled([planilla.registrarPago(periodoId, administradores[1])]);
  pausa.liberar();
  const apertura = await Promise.allSettled([reabrir]);
  const respuestas = [...pago, ...apertura];
  expect(respuestas.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  for (const r of respuestas) if (r.status === 'rejected') {
    expect(r.reason).toBeInstanceOf(ConflictException);
    expect(r.reason.getStatus()).toBe(409);
  }
  const final = await foto();
  expect(final.periodo.resultados).toHaveLength(1);
  expect(final.periodo.ventas).toHaveLength(1);
  expect(final.auditoria.filter(a => ['PAGAR', 'REABRIR'].includes(a.accion))).toHaveLength(1);
  if (final.periodo.estado === 'PAGADO') {
    expect(final.periodo.aprobaciones).toHaveLength(2);
    await expect(planilla.reabrir(periodoId, administradores[0], 'Otro intento')).rejects.toBeInstanceOf(ConflictException);
  } else {
    expect(final.periodo.estado).toBe('CALCULADO');
    expect(final.periodo.pagadoEn).toBeNull();
    expect(final.periodo.aprobaciones).toHaveLength(0);
  }
});

it('B: excluir tras calcular invalida resultados e impide revisar', async () => {
  await planilla.ajustarVenta(ventaId, { comisionable: false, motivoExclusion: 'Devolución' }, administradores[0]);
  await expect(planilla.enviarARevision(periodoId, administradores[0])).rejects.toBeInstanceOf(ConflictException);
  await expect(planilla.aprobar(periodoId, administradores[0])).rejects.toBeInstanceOf(ConflictException);
  const final = await foto();
  expect(final.periodo.estado).toBe('BORRADOR');
  expect(final.periodo.resultados).toEqual([]);
  expect(final.periodo.calculadoEn).toBeNull();
  expect(final.periodo.configuracionUsada).toBeNull();
  expect(final.periodo.aprobaciones).toEqual([]);
  expect(final.periodo.ventas[0]).toMatchObject({ comisionable: false, motivoExclusion: 'Devolución' });
});

it('C: un cálculo en curso no sobrescribe la entrada en revisión', async () => {
  const pausa = barrera();
  const cargar = config.cargarConfiguracion.bind(config);
  jest.spyOn(config, 'cargarConfiguracion').mockImplementationOnce(async (...args) => {
    const datos = await cargar(...args);
    await pausa.pausar();
    return datos;
  });
  const calculando = calculo.calcular(periodoId, administradores[0]);
  void calculando.catch(() => undefined);
  await pausa.llegada;
  const revision = await Promise.allSettled([planilla.enviarARevision(periodoId, administradores[1])]);
  pausa.liberar();
  const calculado = await Promise.allSettled([calculando]);
  expect([...revision, ...calculado].filter(r => r.status === 'fulfilled')).toHaveLength(1);
  for (const r of [...revision, ...calculado]) if (r.status === 'rejected') expect(r.reason.getStatus()).toBe(409);
  const final = await foto();
  expect(final.periodo.resultados).toHaveLength(1);
  if (final.periodo.estado === 'CALCULADO') expect(final.periodo.enRevisionDesde).toBeNull();
});

it('D: repetir realmente la aprobación no duplica la firma ni el cierre', async () => {
  await planilla.enviarARevision(periodoId, administradores[0]);
  await planilla.aprobar(periodoId, administradores[0], 'Conforme');
  const primera = await foto();
  await planilla.aprobar(periodoId, administradores[0], 'Conforme');
  expect(await foto()).toEqual(primera);
  await planilla.aprobar(periodoId, administradores[1], 'Conforme');
  const cerrado = await foto();
  await planilla.aprobar(periodoId, administradores[1], 'Conforme');
  expect(await foto()).toEqual(cerrado);
  expect(cerrado.periodo.aprobaciones).toHaveLength(2);
  expect(cerrado.auditoria.filter(a => a.accion === 'CERRAR')).toHaveLength(1);
});

it('D: dos aprobadores concurrentes solo producen un cierre', async () => {
  await planilla.enviarARevision(periodoId, administradores[0]);
  const pausa = barrera();
  const interno = planilla as unknown as { superAdminsActivos(tx?: Prisma.TransactionClient): Promise<Array<{ id: string; nombre: string }>> };
  const consultar = interno.superAdminsActivos.bind(planilla);
  jest.spyOn(interno, 'superAdminsActivos').mockImplementationOnce(async (...args) => {
    await pausa.pausar();
    return consultar(...args);
  });
  const firmas = prisma.aprobacionPeriodo.findMany.bind(prisma.aprobacionPeriodo);
  jest.spyOn(prisma.aprobacionPeriodo, 'findMany').mockImplementationOnce(args => Object.assign((async () => {
    await pausa.pausar();
    return firmas(args);
  })(), { [Symbol.toStringTag]: 'PrismaPromise' as const }));
  const primera = planilla.aprobar(periodoId, administradores[0]);
  void primera.catch(() => undefined);
  await pausa.llegada;
  const [segunda] = await Promise.allSettled([planilla.aprobar(periodoId, administradores[1])]);
  pausa.liberar();
  await primera;
  if (segunda.status === 'rejected') {
    expect(segunda.reason).toBeInstanceOf(ConflictException);
    await planilla.aprobar(periodoId, administradores[1]);
  }
  const final = await foto();
  expect(final.periodo.estado).toBe('CERRADO');
  expect(final.periodo.aprobaciones).toHaveLength(2);
  expect(final.auditoria.filter(a => a.accion === 'CERRAR')).toHaveLength(1);
});

it('la auditoría obligatoria fallida revierte la reapertura y sus firmas', async () => {
  await cerrar();
  const anterior = await foto();
  await expect(planilla.reabrir(periodoId, administradores[0], 'F03_FALLO_AUDITORIA'))
    .rejects.toThrow('F03: auditoria obligatoria fallida');
  expect(await foto()).toEqual(anterior);
});

it('A: cuando el pago toma primero el lock, la reapertura obtiene 409 y PAGADO es terminal', async () => {
  await cerrar();
  const pausa = barrera();
  const obtener = planilla.obtenerPeriodo.bind(planilla);
  jest.spyOn(planilla, 'obtenerPeriodo').mockImplementationOnce(async (...args) => {
    const periodo = await obtener(...args);
    await pausa.pausar();
    return periodo;
  });
  const pago = planilla.registrarPago(periodoId, administradores[0]);
  void pago.catch(() => undefined);
  await pausa.llegada;
  try {
    await expect(planilla.reabrir(periodoId, administradores[1], 'Corrección')).rejects.toMatchObject({ status: 409 });
  } finally { pausa.liberar(); }
  await pago;
  const pagado = await foto();
  expect(pagado.periodo.estado).toBe('PAGADO');
  expect(pagado.periodo.aprobaciones).toHaveLength(2);
  expect(pagado.periodo.resultados).toHaveLength(1);
  const intentos = [
    () => planilla.reabrir(periodoId, administradores[0], 'Otra corrección'),
    () => planilla.registrarPago(periodoId, administradores[0]),
    () => planilla.rechazar(periodoId, administradores[0], 'Rechazo tardío'),
    () => planilla.enviarARevision(periodoId, administradores[0]),
    () => planilla.aprobar(periodoId, administradores[0]),
    () => planilla.ajustarVenta(ventaId, { comisionable: true }, administradores[0]),
    () => calculo.calcular(periodoId, administradores[0]),
    () => planilla.eliminarPeriodo(periodoId, administradores[0]),
  ];
  for (const intentar of intentos) {
    await expect(intentar()).rejects.toMatchObject({ status: 409 });
    expect(await foto()).toEqual(pagado);
  }
});

it('B: incluir, cambiar la selección de planes y reasignar venta exigen un nuevo cálculo', async () => {
  for (const dto of [{ comisionable: true }, { comisionaPlan: false }, { vendedoraId: (await foto()).periodo.ventas[0].vendedoraId! }]) {
    await planilla.ajustarVenta(ventaId, dto, administradores[0]);
    const invalidado = await foto();
    expect(invalidado.periodo.estado).toBe('BORRADOR');
    expect(invalidado.periodo.resultados).toEqual([]);
    expect(invalidado.periodo.aprobaciones).toEqual([]);
    await expect(planilla.enviarARevision(periodoId, administradores[0])).rejects.toMatchObject({ status: 409 });
    await calculo.calcular(periodoId, administradores[0]);
    expect((await foto()).periodo.estado).toBe('CALCULADO');
  }
  await cerrar();
  expect((await foto()).periodo.estado).toBe('CERRADO');
});

it('C: la configuración global y las condiciones de vendedora se fotografían desde una sola instantánea', async () => {
  const original = await prisma.tarifaServicio.findUniqueOrThrow({ where: { clasif: 'CONSULTA' } });
  const anterior = await foto();
  const pausa = barrera();
  const cargar = config.cargarConfiguracion.bind(config);
  jest.spyOn(config, 'cargarConfiguracion').mockImplementationOnce(async (...args) => {
    await pausa.pausar();
    return cargar(...args);
  });
  const calculando = calculo.calcular(periodoId, administradores[0]);
  void calculando.catch(() => undefined);
  await pausa.llegada;
  try {
    await config.actualizarTarifaServicio('CONSULTA', { pctEmpresa: 0.123, pctPropio: 0.234 });
    await planilla.actualizarVendedora(anterior.periodo.ventas[0].vendedoraId!, { sueldoBase: 777 }, administradores[0]);
    pausa.liberar();
    await calculando;
    const congelado = await foto();
    const reglas = congelado.periodo.configuracionUsada as Prisma.JsonObject;
    expect(reglas.tarifasServicio).toEqual((anterior.periodo.configuracionUsada as Prisma.JsonObject).tarifasServicio);
    expect(congelado.periodo.resultados[0].sueldoBase.toString()).toBe('0');
    expect(congelado.periodo.resultados[0].totalUsd).toEqual(anterior.periodo.resultados[0].totalUsd);
    await calculo.calcular(periodoId, administradores[0]);
    const nuevo = await foto();
    expect(nuevo.periodo.resultados[0].sueldoBase.toString()).toBe('777');
    expect(nuevo.periodo.configuracionUsada).not.toEqual(congelado.periodo.configuracionUsada);
  } finally {
    pausa.liberar();
    await Promise.allSettled([calculando]);
    await prisma.tarifaServicio.update({ where: { clasif: 'CONSULTA' }, data: { pctEmpresa: original.pctEmpresa, pctPropio: original.pctPropio } });
  }
});

it('D: dos llamadas concurrentes de la misma persona conservan una sola firma y un solo hecho APROBAR', async () => {
  await planilla.enviarARevision(periodoId, administradores[0]);
  const respuestas = await Promise.allSettled([
    planilla.aprobar(periodoId, administradores[0], 'Conforme'),
    planilla.aprobar(periodoId, administradores[0], 'Conforme'),
  ]);
  expect(respuestas.some(r => r.status === 'fulfilled')).toBe(true);
  for (const r of respuestas) if (r.status === 'rejected') expect(r.reason.getStatus()).toBe(409);
  await planilla.aprobar(periodoId, administradores[0], 'Conforme');
  const final = await foto();
  expect(final.periodo.estado).toBe('EN_REVISION');
  expect(final.periodo.aprobaciones).toHaveLength(1);
  expect(final.auditoria.filter(a => a.accion === 'APROBAR')).toHaveLength(1);
  expect(final.auditoria.filter(a => a.accion === 'CERRAR')).toHaveLength(0);
});

it('una transición o exclusión inválida no modifica ventas, resultados, firmas ni auditoría', async () => {
  const anterior = await foto();
  await expect(planilla.registrarPago(periodoId, administradores[0])).rejects.toMatchObject({ status: 409 });
  expect(await foto()).toEqual(anterior);
  await expect(planilla.ajustarVenta(ventaId, { comisionable: false }, administradores[0])).rejects.toMatchObject({ status: 400 });
  expect(await foto()).toEqual(anterior);
});

const metas = { planpaqMinimos: 4, planninMinimos: 4, montoMensualUsd: 12000, montoTrimestralUsd: 15000 };

it('las tres puertas de metas propias invalidan el cálculo y respetan el cierre', async () => {
  const objetivo = await config.guardarObjetivoDePeriodo(periodoId, 'VENDEDORA', metas, administradores[0]);
  expect((await foto()).periodo.estado).toBe('BORRADOR');
  expect((await foto()).periodo.resultados).toEqual([]);
  await calculo.calcular(periodoId, administradores[0]);
  await config.actualizarObjetivo(objetivo.id, { ...metas, planpaqMinimos: 5 }, administradores[0]);
  expect((await foto()).periodo.estado).toBe('BORRADOR');
  await calculo.calcular(periodoId, administradores[0]);
  await config.eliminarObjetivoDePeriodo(periodoId, 'VENDEDORA', administradores[0]);
  expect((await foto()).periodo.estado).toBe('BORRADOR');
  const propia = await config.guardarObjetivoDePeriodo(periodoId, 'VENDEDORA', metas, administradores[0]);
  await calculo.calcular(periodoId, administradores[0]);
  await cerrar();
  const cerrado = await foto();
  for (const intento of [
    () => config.guardarObjetivoDePeriodo(periodoId, 'VENDEDORA', metas, administradores[0]),
    () => config.actualizarObjetivo(propia.id, metas, administradores[0]),
    () => config.eliminarObjetivoDePeriodo(periodoId, 'VENDEDORA', administradores[0]),
  ]) {
    await expect(intento()).rejects.toMatchObject({ status: 409 });
    expect(await foto()).toEqual(cerrado);
  }
});

it.each(['CALCULAR', 'CERRAR', 'AJUSTAR', 'PAGAR'])('si falla la auditoría %s se revierte todo el comando', async accion => {
  if (accion === 'CERRAR') {
    await planilla.enviarARevision(periodoId, administradores[0]);
    await planilla.aprobar(periodoId, administradores[0]);
  }
  if (accion === 'PAGAR') await cerrar();
  const anterior = await foto();
  await prisma.$executeRaw`INSERT INTO f03_fallos_audit (accion) VALUES (${accion})`;
  const comandos: Record<string, () => Promise<unknown>> = {
    CALCULAR: () => calculo.calcular(periodoId, administradores[0]),
    CERRAR: () => planilla.aprobar(periodoId, administradores[1]),
    AJUSTAR: () => planilla.ajustarVenta(ventaId, { comisionable: false, motivoExclusion: 'Corrección' }, administradores[0]),
    PAGAR: () => planilla.registrarPago(periodoId, administradores[0]),
  };
  await expect(comandos[accion]()).rejects.toThrow('F03: auditoria obligatoria fallida');
  expect(await foto()).toEqual(anterior);
});

it('reabrir conserva la foto de la liquidación y sus firmas antes de retirarlas', async () => {
  await cerrar();
  const cerrado = await foto();
  await planilla.reabrir(periodoId, administradores[0], 'Revisar comisión');
  const abierto = await foto();
  const evidencia = abierto.auditoria.find(a => a.accion === 'REABRIR')!.cambios as Prisma.JsonObject;
  const anterior = evidencia.anterior as Prisma.JsonObject;
  expect(anterior.configuracionUsada).toEqual(cerrado.periodo.configuracionUsada);
  expect(anterior.resultados).toEqual(JSON.parse(JSON.stringify(cerrado.periodo.resultados)));
  expect(anterior.aprobaciones).toHaveLength(2);
  expect(abierto.periodo.aprobaciones).toEqual([]);
  expect(abierto.periodo.resultados).toEqual(cerrado.periodo.resultados);
  expect(abierto.periodo.estado).toBe('CALCULADO');
});

it('una instantánea anterior a la liberación del lock falla con 409, aunque el estado no haya cambiado', async () => {
  await planilla.enviarARevision(periodoId, administradores[0]);
  const pausa = barrera();
  const obsoleta = transaccionFinanciera(prisma, async tx => {
    await tx.periodoComision.findUniqueOrThrow({ where: { id: periodoId } });
    await pausa.pausar();
    await bloquearPeriodo(tx, 2032, 1);
    throw new Error('No debe aceptar una instantánea anterior a la firma');
  });
  void obsoleta.catch(() => undefined);
  await pausa.llegada;
  await planilla.aprobar(periodoId, administradores[0]);
  const firmado = await foto();
  pausa.liberar();
  await expect(obsoleta).rejects.toMatchObject({ status: 409 });
  expect(await foto()).toEqual(firmado);
});

it('los comandos de otro periodo pueden avanzar mientras se calcula este mes', async () => {
  const otro = await prisma.periodoComision.create({ data: { anio: 2032, mes: 2, tipoCambio: 6.97 } });
  const pausa = barrera();
  const cargar = config.cargarConfiguracion.bind(config);
  jest.spyOn(config, 'cargarConfiguracion').mockImplementationOnce(async (...args) => {
    await pausa.pausar();
    return cargar(...args);
  });
  const calculando = calculo.calcular(periodoId, administradores[0]);
  void calculando.catch(() => undefined);
  await pausa.llegada;
  try {
    await expect(planilla.eliminarPeriodo(otro.id, administradores[0])).resolves.toEqual({ eliminado: true });
  } finally { pausa.liberar(); }
  await calculando;
  expect((await foto()).periodo.estado).toBe('CALCULADO');
});

it('la publicación de F02 comparte el lock con el cálculo y conserva las filas ante 409', async () => {
  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet([{
    FECHA: '2032-01-10', MODULO: 'CONSULTA', DETALLE: 'Consulta F03 nueva',
    PRECIO: 200, TC: 6.97, VENDEDORA_PK: 'F03-V', VENDEDORA: 'Vendedora F03',
  }]), 'Ventas');
  const excel = XLSX.write(libro, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  const pausa = barrera();
  const cargar = config.cargarConfiguracion.bind(config);
  jest.spyOn(config, 'cargarConfiguracion').mockImplementationOnce(async (...args) => {
    await pausa.pausar();
    return cargar(...args);
  });
  const anterior = await foto();
  const calculando = calculo.calcular(periodoId, administradores[0]);
  void calculando.catch(() => undefined);
  await pausa.llegada;
  try {
    await expect(planilla.importar(excel, 'f03.xlsx', { anio: 2032, mes: 1, tipoCambio: 6.97 }, administradores[1]))
      .rejects.toMatchObject({ status: 409 });
    expect(await foto()).toEqual(anterior);
  } finally { pausa.liberar(); }
  await calculando;
  expect((await foto()).periodo.ventas).toEqual(anterior.periodo.ventas);
});

it('reclasificar pendientes se excluye con el cálculo e invalida una sola vez por periodo', async () => {
  await prisma.ventaImportada.update({ where: { id: ventaId }, data: { requiereRevision: true } });
  const regla: ReglaDiccionario = {
    patron: 'CONSULTA F03', exacto: true, modulo: null, clasif: 'LAB', nivel: null, unidadNegocio: null, prioridad: 1,
  };
  const pausa = barrera();
  const cargar = config.cargarConfiguracion.bind(config);
  jest.spyOn(config, 'cargarConfiguracion').mockImplementationOnce(async (...args) => {
    await pausa.pausar();
    return cargar(...args);
  });
  const calculando = calculo.calcular(periodoId, administradores[0]);
  void calculando.catch(() => undefined);
  await pausa.llegada;
  const anterior = await foto();
  try {
    await expect(planilla.reclasificarConRegla(regla, administradores[1])).rejects.toMatchObject({ status: 409 });
    expect(await foto()).toEqual(anterior);
  } finally { pausa.liberar(); }
  await calculando;
  await expect(planilla.reclasificarConRegla(regla, administradores[1])).resolves.toBe(1);
  const final = await foto();
  expect(final.periodo.estado).toBe('BORRADOR');
  expect(final.periodo.resultados).toEqual([]);
  expect(final.periodo.configuracionUsada).toBeNull();
  expect(final.periodo.ventas[0]).toMatchObject({ clasif: 'LAB', requiereRevision: false });
  expect(final.auditoria.filter(a => a.accion === 'RECLASIFICAR')).toHaveLength(1);
});

it('rechazar retira las firmas; editar después obliga a calcular antes de revisar de nuevo', async () => {
  await planilla.enviarARevision(periodoId, administradores[0]);
  await planilla.aprobar(periodoId, administradores[0]);
  const revisado = await foto();
  await planilla.rechazar(periodoId, administradores[1], 'Corregir clasificación');
  const rechazado = await foto();
  expect(rechazado.periodo.estado).toBe('CALCULADO');
  expect(rechazado.periodo.aprobaciones).toEqual([]);
  expect(rechazado.periodo.resultados).toEqual(revisado.periodo.resultados);
  await planilla.ajustarVenta(ventaId, { clasif: 'LAB' }, administradores[1]);
  await expect(planilla.enviarARevision(periodoId, administradores[0])).rejects.toMatchObject({ status: 409 });
  await calculo.calcular(periodoId, administradores[0]);
  await planilla.enviarARevision(periodoId, administradores[0]);
  expect((await foto()).periodo.aprobaciones).toEqual([]);
});
