import { ConfigService } from '@nestjs/config';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientesService } from '../clientes/clientes.service';
import { ServiciosService } from '../servicios/servicios.service';
import { IngestaWhatsappService } from '../conversaciones/ingesta-whatsapp.service';
import { ConversacionesGateway } from '../conversaciones/conversaciones.gateway';
import { AcuseAutomaticoService } from '../conversaciones/acuse-automatico.service';
import { DespachadorSalienteService } from '../conversaciones/despachador-saliente.service';
import { MediaEntranteService } from '../conversaciones/media-entrante.service';
import { PrimerContactoService } from './primer-contacto.service';

// Base desechable fija: nunca se toma DATABASE_URL del entorno.
const URL = 'postgresql://crm_app:crm_dev_local@127.0.0.1:5433/crm_test';
const prisma = new PrismaService(URL);
const segunda = new PrismaService(URL);
const LINEA = 'f0620000-0000-4000-8000-000000000001';
const OTRA = 'f0620000-0000-4000-8000-000000000002';
const NO_COMERCIAL = 'f0620000-0000-4000-8000-000000000003';
const TELEFONO = '+59178062001';
const gateway = { notificarEntrante: jest.fn(), emitirActividad: jest.fn() };

function clientes(db = prisma) {
  return new ClientesService(db, new AuditService(db), new ServiciosService(db));
}
function worker(db = prisma) {
  const s = new PrimerContactoService(db, clientes(db));
  for (const nivel of ['warn', 'error', 'log'] as const) jest.spyOn(s['logger'], nivel).mockImplementation(() => undefined);
  return s;
}
function ingesta(s = worker(), db = prisma) {
  return new IngestaWhatsappService(db, clientes(db), gateway as unknown as ConversacionesGateway,
    new AcuseAutomaticoService(new ConfigService({})), {} as DespachadorSalienteService,
    { despertar: jest.fn() } as unknown as MediaEntranteService, s);
}
function recibir(s = ingesta(), id = 'wamid.f062', linea = LINEA, telefono = TELEFONO) {
  return s.procesarEntrante(telefono, 'Consulta comercial', id, 'Paciente ficticia',
    undefined, undefined, false, linea);
}
async function fallo(tipo: string) {
  await prisma.$executeRawUnsafe('INSERT INTO "_f062_fallos" ("tipo") VALUES ($1) ON CONFLICT DO NOTHING', tipo);
}
async function quitarFallos() { await prisma.$executeRawUnsafe('DELETE FROM "_f062_fallos"'); }
async function trabajo() {
  return prisma.primerContactoWhatsapp.findFirstOrThrow({
    where: { conversacion: { cliente: { telefono: TELEFONO }, lineaId: LINEA } },
  });
}
async function vencer(conversacionId: string) {
  await prisma.primerContactoWhatsapp.update({ where: { conversacionId }, data: { proximoIntento: new Date(0) } });
}
async function conteos(mensajes: number, leads: number, trabajos = 1) {
  expect(await prisma.mensaje.count({ where: { conversacion: { cliente: { telefono: TELEFONO } } } })).toBe(mensajes);
  expect(await prisma.lead.count({ where: { cliente: { telefono: TELEFONO } } })).toBe(leads);
  expect(await prisma.primerContactoWhatsapp.count({ where: { conversacion: { cliente: { telefono: TELEFONO } } } })).toBe(trabajos);
}

beforeAll(async () => {
  await prisma.$connect(); await segunda.$connect();
  await prisma.$executeRawUnsafe('CREATE TABLE "_f062_fallos" ("tipo" text PRIMARY KEY)');
  await prisma.$executeRawUnsafe([
    'CREATE FUNCTION "_f062_fallar"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN',
    "IF (TG_TABLE_NAME = 'Lead' AND EXISTS (SELECT 1 FROM \"_f062_fallos\" WHERE tipo='lead'))",
    "OR (TG_TABLE_NAME = 'Mensaje' AND EXISTS (SELECT 1 FROM \"_f062_fallos\" WHERE tipo='mensaje'))",
    "OR (TG_TABLE_NAME = 'PrimerContactoWhatsapp' AND TG_OP='INSERT' AND EXISTS (SELECT 1 FROM \"_f062_fallos\" WHERE tipo='reserva')) THEN",
    "RAISE EXCEPTION 'dato-paciente-token-ficticio-no-registrar'; END IF;",
    "IF TG_TABLE_NAME = 'PrimerContactoWhatsapp' AND TG_OP='UPDATE' THEN",
    "IF (NEW.\"leadId\" IS NOT NULL AND EXISTS (SELECT 1 FROM \"_f062_fallos\" WHERE tipo='enlace'))",
    "OR (NEW.\"mensajeId\" IS NOT NULL AND NEW.\"leadId\" IS NULL AND EXISTS (SELECT 1 FROM \"_f062_fallos\" WHERE tipo='preparar')) THEN",
    "RAISE EXCEPTION 'dato-paciente-token-ficticio-no-registrar'; END IF; END IF;",
    "IF TG_TABLE_NAME = 'Lead' AND EXISTS (SELECT 1 FROM \"_f062_fallos\" WHERE tipo='bloquear') THEN",
    'PERFORM pg_advisory_xact_lock(620062); END IF; RETURN NEW; END $$',
  ].join('\n'));
  for (const tabla of ['Lead', 'Mensaje', 'PrimerContactoWhatsapp']) {
    await prisma.$executeRawUnsafe('CREATE TRIGGER "_f062_fallar" BEFORE INSERT OR UPDATE ON "' + tabla +
      '" FOR EACH ROW EXECUTE FUNCTION "_f062_fallar"()');
  }
  for (const [id, comercial] of [[LINEA, true], [OTRA, true], [NO_COMERCIAL, false]] as const) {
    await prisma.lineaWhatsapp.create({ data: { id, nombre: 'F062 ficticia', tokenEnv: 'F062_TOKEN', comercial, activa: true } });
  }
});
beforeEach(async () => {
  await quitarFallos();
  await prisma.cliente.deleteMany({ where: { telefono: { startsWith: '+59178062' } } });
  await prisma.usuario.deleteMany({ where: { email: { endsWith: '@f062.test' } } });
  gateway.notificarEntrante.mockClear(); gateway.emitirActividad.mockClear();
});
afterEach(async () => { jest.restoreAllMocks(); await quitarFallos(); });
afterAll(async () => {
  for (const tabla of ['Lead', 'Mensaje', 'PrimerContactoWhatsapp']) {
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS "_f062_fallar" ON "' + tabla + '"');
  }
  await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS "_f062_fallar"()');
  await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "_f062_fallos"');
  await prisma.cliente.deleteMany({ where: { telefono: { startsWith: '+59178062' } } });
  await prisma.usuario.deleteMany({ where: { email: { endsWith: '@f062.test' } } });
  await prisma.lineaWhatsapp.deleteMany({ where: { id: { in: [LINEA, OTRA, NO_COMERCIAL] } } });
  await prisma.$disconnect(); await segunda.$disconnect();
});

test('A: primer mensaje comercial confirma conversación, mensaje y un lead', async () => {
  const m = await recibir(); await conteos(1, 1);
  expect(await trabajo()).toMatchObject({ mensajeId: m.id, intentos: 1, proximoIntento: null, ultimoError: null });
  expect((await trabajo()).leadId).not.toBeNull();
  expect(gateway.notificarEntrante).toHaveBeenCalledTimes(1);
});

test('B: INSERT Lead falla en PostgreSQL; mensaje y aviso sobreviven, retry completa sin webhook', async () => {
  await fallo('lead'); await recibir(); await conteos(1, 0);
  const t = await trabajo();
  expect(t.intentos).toBe(1);
  expect(t.ultimoError).toMatch(/^POSTGRES_P\d{4}$/);
  expect(JSON.stringify(t)).not.toContain('dato-paciente-token');
  expect(t.proximoIntento!.getTime() - Date.now()).toBeGreaterThan(50_000);
  expect(await worker().barrerPendientes()).toBe(0);
  expect(gateway.notificarEntrante).toHaveBeenCalledTimes(1);
  await quitarFallos(); await vencer(t.conversacionId);
  expect(await worker().barrerPendientes()).toBe(1);
  await conteos(1, 1);
  expect(await trabajo()).toMatchObject({ intentos: 2, proximoIntento: null, ultimoError: null });
  expect(gateway.notificarEntrante).toHaveBeenCalledTimes(1);
});

test('C: falla mensaje tras crear chat; reserva sobrevive y el reintento arma el alta', async () => {
  await fallo('mensaje'); await expect(recibir()).rejects.toThrow(); await conteos(0, 0);
  expect(await trabajo()).toMatchObject({ mensajeId: null, origen: null, proximoIntento: null, intentos: 0 });
  expect(await worker().barrerPendientes()).toBe(0);
  await quitarFallos(); await recibir(ingesta(worker(segunda), segunda));
  await conteos(1, 1); expect(gateway.notificarEntrante).toHaveBeenCalledTimes(1);
});

test('D: duplicado pendiente no repite mensaje, trabajo, intento ni aviso', async () => {
  await fallo('lead'); const primero = await recibir(); const antes = await trabajo(); await quitarFallos();
  expect((await recibir()).id).toBe(primero.id);
  expect(await trabajo()).toEqual(antes);
  await vencer(antes.conversacionId); await worker().barrerPendientes(); await recibir(); await conteos(1, 1);
  expect(gateway.notificarEntrante).toHaveBeenCalledTimes(1);
});

test.each([true, false])('E: dos conexiones, webhooks concurrentes (mismo id=%s)', async mismo => {
  const [a, b] = await Promise.all([recibir(ingesta()),
    recibir(ingesta(worker(segunda), segunda), mismo ? 'wamid.f062' : 'wamid.f062.otro')]);
  await worker().barrerPendientes(); await conteos(mismo ? 1 : 2, 1);
  if (mismo) expect(a.id).toBe(b.id);
  expect(gateway.notificarEntrante).toHaveBeenCalledTimes(mismo ? 1 : 2);
});

test('F: desconectar tras confirmar mensaje; una instancia nueva barre y completa', async () => {
  const anterior = new PrismaService(URL); await anterior.$connect(); const s = worker(anterior);
  // Costura de terminación: no sustituye ninguna operación PostgreSQL.
  jest.spyOn(s, 'procesarUno').mockRejectedValueOnce(new Error('proceso terminado'));
  await expect(recibir(ingesta(s, anterior))).rejects.toThrow('proceso terminado');
  await s.onModuleDestroy(); await anterior.$disconnect(); await conteos(1, 0);
  const nueva = new PrismaService(URL); await nueva.$connect(); const recuperador = worker(nueva);
  try {
    expect(await recuperador.barrerPendientes()).toBe(1);
    expect(await recuperador.barrerPendientes()).toBe(0); await conteos(1, 1);
  } finally { await recuperador.onModuleDestroy(); await nueva.$disconnect(); }
});

test('G: conserva oportunidades históricas y sus estados', async () => {
  const c = await prisma.cliente.create({ data: { nombre: 'Ficticia', telefono: TELEFONO } });
  const historicos = await Promise.all((['PERDIDO', 'CONVERTIDO'] as const).map(estado =>
    prisma.lead.create({ data: { clienteId: c.id, origen: 'PRESENCIAL', estado } })));
  await recibir(); await recibir(); await conteos(1, 3);
  for (const h of historicos) expect(await prisma.lead.findUnique({ where: { id: h.id } })).toEqual(h);
});

test('H: línea no comercial no reserva ni crea lead', async () => {
  await recibir(ingesta(), 'wamid.f062.clinico', NO_COMERCIAL);
  expect(await worker().barrerPendientes()).toBe(0); await conteos(1, 0, 0);
});

test('multicanal: dos números comerciales y uno clínico conservan identidades independientes', async () => {
  await Promise.all([recibir(ingesta(), 'wamid.f062.ventas', LINEA),
    recibir(ingesta(worker(segunda), segunda), 'wamid.f062.otra', OTRA),
    recibir(ingesta(), 'wamid.f062.clinico', NO_COMERCIAL)]);
  await conteos(3, 2, 2);
  expect(await prisma.conversacion.count({ where: { cliente: { telefono: TELEFONO } } })).toBe(3);
});

test('conversación anterior sin reserva no se arma retrospectivamente', async () => {
  const c = await prisma.cliente.create({ data: { nombre: 'Ficticia', telefono: TELEFONO } });
  await prisma.conversacion.create({ data: { clienteId: c.id, lineaId: LINEA } });
  await recibir(); await conteos(1, 0, 0);
});

test('fallo al insertar reserva revierte conversación; retry puede reservarla', async () => {
  await fallo('reserva'); await expect(recibir()).rejects.toThrow();
  expect(await prisma.conversacion.count({ where: { cliente: { telefono: TELEFONO } } })).toBe(0);
  await quitarFallos(); await recibir(); await conteos(1, 1);
});

test('fallo al preparar trabajo revierte mensaje y conserva reserva sin activar', async () => {
  await fallo('preparar'); await expect(recibir()).rejects.toThrow(); await conteos(0, 0);
  expect((await trabajo()).mensajeId).toBeNull();
  expect(gateway.notificarEntrante).not.toHaveBeenCalled();
  await quitarFallos(); await recibir(); await conteos(1, 1);
});

test('fallo después del INSERT Lead revierte alta antes del retry, sin lead huérfano', async () => {
  await fallo('enlace'); await recibir(); await conteos(1, 0); const t = await trabajo();
  expect(t.intentos).toBe(1);
  await quitarFallos(); await vencer(t.conversacionId); await worker().barrerPendientes(); await conteos(1, 1);
});

test('dos workers: el segundo salta la fila mientras el primero está dentro del INSERT', async () => {
  await fallo('lead'); await recibir(); await quitarFallos();
  const t = await trabajo(); await vencer(t.conversacionId); await fallo('bloquear');
  let liberar!: () => void; let bloqueoListo!: () => void;
  const listo = new Promise<void>(resolve => { bloqueoListo = resolve; });
  const puerta = new Promise<void>(resolve => { liberar = resolve; });
  const bloqueo = prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(620062)');
    bloqueoListo(); await puerta;
  }, { timeout: 10_000 });
  await listo;
  const primero = worker().procesarUno(t.conversacionId);
  try {
    const limite = Date.now() + 2_000; let esperando = false;
    while (!esperando && Date.now() < limite) {
      const rows = await segunda.$queryRawUnsafe<Array<{ n: number }>>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = 'crm_test' AND wait_event = 'advisory'");
      esperando = rows[0].n > 0;
      if (!esperando) await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(esperando).toBe(true);
    expect(await worker(segunda).procesarUno(t.conversacionId)).toBe(false);
  } finally { liberar(); await bloqueo; }
  expect(await primero).toBe(true); await conteos(1, 1);
  expect((await trabajo()).intentos).toBe(2);
});

test('ownership: recuperación hereda dueña comercial vigente', async () => {
  const a = await prisma.usuario.create({ data: { nombre: 'A', email: 'a@f062.test', passwordHash: 'x', rol: 'AGENTE' } });
  const b = await prisma.usuario.create({ data: { nombre: 'B', email: 'b@f062.test', passwordHash: 'x', rol: 'AGENTE' } });
  const c = await prisma.cliente.create({ data: { nombre: 'Ficticia', telefono: TELEFONO, agenteId: a.id } });
  await fallo('lead'); await recibir(); await clientes().update(c.id, { agenteId: b.id });
  await quitarFallos(); await vencer((await trabajo()).conversacionId); await worker().barrerPendientes();
  expect((await prisma.lead.findUniqueOrThrow({ where: { id: (await trabajo()).leadId! } })).agenteId).toBe(b.id);
});

test('atribución del primer mensaje confirmado; anuncio compartido no único', async () => {
  await fallo('lead');
  await ingesta().procesarEntrante(TELEFONO, 'hola', 'wamid.f062', 'Ficticia', undefined,
    { anuncioId: 'anuncio-compartido', origenTipo: 'instagram' }, false, LINEA);
  await ingesta().procesarEntrante(TELEFONO, 'otro', 'wamid.f062.otro', 'Ficticia', undefined,
    { anuncioId: 'anuncio-posterior' }, false, LINEA);
  await quitarFallos(); await vencer((await trabajo()).conversacionId); await worker().barrerPendientes();
  await ingesta().procesarEntrante('+59178062002', 'hola', 'wamid.f062.otra-persona', 'Ficticia', undefined,
    { anuncioId: 'anuncio-compartido', origenTipo: 'instagram' }, false, LINEA);
  const leads = await prisma.lead.findMany({ where: { anuncioId: 'anuncio-compartido' } });
  expect(leads).toHaveLength(2);
  expect(leads.every(l => l.metaLeadId === null && l.origen === 'INSTAGRAM_LEAD_AD')).toBe(true);
});

test('constraints e índices físicos, rechazo de estado incoherente y reserva duplicada', async () => {
  const constraints = await prisma.$queryRawUnsafe<Array<{ conname: string; convalidated: boolean }>>(
    'SELECT conname, convalidated FROM pg_constraint WHERE conrelid = \'"PrimerContactoWhatsapp"\'::regclass');
  for (const nombre of ['pkey', 'estado_check', 'conversacionId_fkey', 'mensajeId_fkey', 'leadId_fkey']) {
    expect(constraints).toContainEqual({ conname: 'PrimerContactoWhatsapp_' + nombre, convalidated: true });
  }
  const indices = await prisma.$queryRawUnsafe<Array<{ indexname: string; indexdef: string }>>(
    "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'PrimerContactoWhatsapp'");
  for (const columna of ['mensajeId', 'leadId']) expect(indices).toContainEqual(expect.objectContaining({
    indexname: 'PrimerContactoWhatsapp_' + columna + '_key', indexdef: expect.stringContaining('UNIQUE INDEX'),
  }));
  expect(indices).toContainEqual(expect.objectContaining({ indexname: 'PrimerContactoWhatsapp_proximoIntento_conversacionId_idx' }));
  await recibir(); const t = await trabajo();
  await expect(prisma.primerContactoWhatsapp.update({
    where: { conversacionId: t.conversacionId }, data: { proximoIntento: new Date() },
  })).rejects.toThrow();
  await expect(prisma.primerContactoWhatsapp.create({ data: { conversacionId: t.conversacionId } }))
    .rejects.toMatchObject({ code: 'P2002' });
  await conteos(1, 1);
});

test('borrar explícitamente lead no lo resucita con nuevos mensajes', async () => {
  await recibir(); const t = await trabajo(); await prisma.lead.delete({ where: { id: t.leadId! } });
  await recibir(ingesta(), 'wamid.f062.otro');
  expect(await worker().barrerPendientes()).toBe(0); await conteos(2, 0, 0);
});

test('lote limitado: once altas pendientes completan en dos barridos, sin duplicación', async () => {
  await fallo('lead');
  for (let n = 1; n <= 11; n++) {
    await recibir(ingesta(), 'wamid.f062.lote.' + n, LINEA, '+59178062' + String(n).padStart(3, '0'));
  }
  await quitarFallos();
  await prisma.primerContactoWhatsapp.updateMany({
    where: { conversacion: { lineaId: LINEA }, leadId: null },
    data: { proximoIntento: new Date(0) },
  });
  const s = worker();
  expect(await s.barrerPendientes()).toBe(10);
  expect(await s.barrerPendientes()).toBe(1);
  expect(await s.barrerPendientes()).toBe(0);
});

test('dos duplicados concurrentes durante fallo de lead mantienen un único intento pendiente', async () => {
  await fallo('lead');
  await Promise.all([recibir(), recibir(ingesta(worker(segunda), segunda))]);
  await conteos(1, 0);
  expect((await trabajo()).intentos).toBe(1);
  expect(gateway.notificarEntrante).toHaveBeenCalledTimes(1);
});

test('reserva sin mensaje no activa lead si la línea dejó de ser comercial', async () => {
  await fallo('mensaje'); await expect(recibir()).rejects.toThrow(); await quitarFallos();
  await prisma.lineaWhatsapp.update({ where: { id: LINEA }, data: { comercial: false } });
  try {
    await recibir();
    expect((await trabajo()).mensajeId).toBeNull();
    expect(await worker().barrerPendientes()).toBe(0);
    await conteos(1, 0);
  } finally {
    await prisma.lineaWhatsapp.update({ where: { id: LINEA }, data: { comercial: true } });
  }
});

test('reasignación concurrente espera al alta y actualiza el lead recién creado (F04)', async () => {
  const a = await prisma.usuario.create({ data: { nombre: 'A', email: 'a@f062.test', passwordHash: 'x', rol: 'AGENTE' } });
  const b = await prisma.usuario.create({ data: { nombre: 'B', email: 'b@f062.test', passwordHash: 'x', rol: 'AGENTE' } });
  const c = await prisma.cliente.create({ data: { nombre: 'Ficticia', telefono: TELEFONO, agenteId: a.id } });
  await fallo('lead'); await recibir(); await quitarFallos();
  const t = await trabajo(); await vencer(t.conversacionId); await fallo('bloquear');
  let liberar!: () => void; let bloqueoListo!: () => void;
  const listo = new Promise<void>(resolve => { bloqueoListo = resolve; });
  const puerta = new Promise<void>(resolve => { liberar = resolve; });
  const bloqueo = prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(620062)');
    bloqueoListo(); await puerta;
  }, { timeout: 10_000 });
  await listo;
  const alta = worker().procesarUno(t.conversacionId);
  let reasignacion: Promise<unknown> | undefined;
  try {
    const limite = Date.now() + 2_000; let esperando = false;
    while (!esperando && Date.now() < limite) {
      const rows = await segunda.$queryRawUnsafe<Array<{ n: number }>>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = 'crm_test' AND wait_event = 'advisory'");
      esperando = rows[0].n > 0;
      if (!esperando) await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(esperando).toBe(true);
    reasignacion = clientes(segunda).update(c.id, { agenteId: b.id });
    const plazo = Date.now() + 2_000; let bloqueada = false;
    while (!bloqueada && Date.now() < plazo) {
      const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = 'crm_test' AND wait_event = 'transactionid'");
      bloqueada = rows[0].n > 0;
      if (!bloqueada) await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(bloqueada).toBe(true);
  } finally { liberar(); await bloqueo; await alta; await reasignacion; }
  expect((await prisma.lead.findUniqueOrThrow({ where: { id: (await trabajo()).leadId! } })).agenteId).toBe(b.id);
  await conteos(1, 1);
});
