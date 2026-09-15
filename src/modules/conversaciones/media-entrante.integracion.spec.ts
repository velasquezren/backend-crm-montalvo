import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { R2Service } from '../../common/storage/r2.service';
import { WhatsappCloudService } from '../../common/whatsapp/whatsapp-cloud.service';
import { AlertasWhatsappService } from '../../common/whatsapp/alertas-whatsapp.service';
import { ClientesService } from '../clientes/clientes.service';
import { ServiciosService } from '../servicios/servicios.service';
import { LineasWhatsappService } from '../lineas-whatsapp/lineas-whatsapp.service';
import { AcuseAutomaticoService } from './acuse-automatico.service';
import { DespachadorSalienteService } from './despachador-saliente.service';
import { ConversacionesGateway } from './conversaciones.gateway';
import { ConversacionesService } from './conversaciones.service';
import { IngestaWhatsappService } from './ingesta-whatsapp.service';
import { MediaEntranteService, MAX_BYTES_MEDIA } from './media-entrante.service';
import { WhatsappWebhookController } from './webhooks/whatsapp-webhook.controller';
import { PLAZO_MEDIA_MS } from './politica-media-entrante';

// Únicas bases admitidas por estas fixtures; red externa sustituida por fetch.
const URL_TEST = 'postgresql://crm_app:crm_dev_local@127.0.0.1:5433/crm_test';
const prisma = new PrismaService(URL_TEST);
const otroPrisma = new PrismaService(URL_TEST);
const LINEA = 'f0600000-0000-4000-8000-000000000001';
const PHONE = 'f06-phone-id';
const config = new ConfigService({
  F06_TOKEN: 'token-ficticio',
  R2_ACCOUNT_ID: 'f06-account', R2_ACCESS_KEY_ID: 'f06-key',
  R2_SECRET_ACCESS_KEY: 'f06-secret', R2_BUCKET: 'f06-bucket',
});
let reloj: Date;
class Worker extends MediaEntranteService {
  protected override ahora(): Date { return new Date(reloj); }
}
const gateway = { emitirActividad: jest.fn(), notificarEntrante: jest.fn() };
let respuestas: { origen: number; descarga: number; r2: number; grande: boolean };
let subidas: string[];
let objetos: Set<string>;
let aceptarSinRespuesta = false;
let llamadasOrigen: number;
let entrada: (() => void) | undefined;
let puerta: Promise<void> | undefined;
let salir: (() => void) | undefined;
let modo: 'normal' | 'timeout' | 'red' = 'normal';

function worker(db = prisma, almacenamiento = new R2Service(config)) {
  const s = new Worker(db, gateway as unknown as ConversacionesGateway, almacenamiento,
    new WhatsappCloudService(), new LineasWhatsappService(db, config));
  jest.spyOn(s['logger'], 'error').mockImplementation(() => undefined);
  jest.spyOn(s['logger'], 'warn').mockImplementation(() => undefined);
  jest.spyOn(s['logger'], 'log').mockImplementation(() => undefined);
  return s;
}

function ingesta(s = worker()) {
  return new IngestaWhatsappService(prisma,
    new ClientesService(prisma, new AuditService(prisma), new ServiciosService(prisma)),
    gateway as unknown as ConversacionesGateway, new AcuseAutomaticoService(config),
    {} as DespachadorSalienteService, s);
}

const recibir = (s = ingesta(), id = 'wamid.f06', mediaId = 'media-f06') =>
  s.procesarEntrante('+59179000001', '', id, 'F06 paciente ficticia',
    { tipo: 'IMAGEN', mediaId, mime: 'image/jpeg' }, undefined, false, LINEA);

async function pendiente() {
  const mensaje = await recibir();
  return { mensaje, trabajo: await prisma.trabajoMediaEntrante.findUniqueOrThrow({ where: { mensajeId: mensaje.id } }) };
}

async function estado(id: string) {
  return prisma.trabajoMediaEntrante.findUniqueOrThrow({ where: { mensajeId: id } });
}

async function habilitarReintento(id: string) {
  const t = await estado(id);
  expect(t.proximoIntento).not.toBeNull();
  reloj = new Date(t.proximoIntento!.getTime() + 1);
}

beforeAll(async () => { await prisma.$connect(); await otroPrisma.$connect(); });
afterAll(async () => {
  await prisma.cliente.deleteMany({ where: { telefono: '+59179000001' } });
  await prisma.lineaWhatsapp.deleteMany({ where: { id: LINEA } });
  await prisma.$disconnect(); await otroPrisma.$disconnect();
});
beforeEach(async () => {
  await prisma.cliente.deleteMany({ where: { telefono: '+59179000001' } });
  await prisma.lineaWhatsapp.upsert({
    where: { id: LINEA },
    create: { id: LINEA, nombre: 'F06 ficticia', tokenEnv: 'F06_TOKEN', activa: true, phoneNumberId: PHONE },
    update: { activa: true },
  });
  reloj = new Date(Date.now() + 1000);
  respuestas = { origen: 200, descarga: 200, r2: 200, grande: false };
  subidas = []; objetos = new Set(); aceptarSinRespuesta = false; llamadasOrigen = 0; entrada = undefined; puerta = undefined; salir = undefined; modo = 'normal';
  gateway.emitirActividad.mockClear(); gateway.notificarEntrante.mockClear();
  jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('https://graph.facebook.com/')) {
      llamadasOrigen++;
      entrada?.();
      if (puerta) await puerta;
      init?.signal?.throwIfAborted();
      if (modo === 'timeout') throw new DOMException('URL-y-token-no-deben-guardarse', 'TimeoutError');
      if (modo === 'red') throw new Error('secreto-no-debe-guardarse');
      return Response.json({ url: 'https://media.f06.invalid/temporal?firma=no-persistir' }, { status: respuestas.origen });
    }
    if (url.startsWith('https://media.f06.invalid/')) {
      return new Response('imagen ficticia', {
        status: respuestas.descarga,
        headers: respuestas.grande ? { 'content-length': String(MAX_BYTES_MEDIA + 1) } : {},
      });
    }
    if (input instanceof Request && input.method === 'PUT' && url.includes('f06-account.r2.cloudflarestorage.com')) {
      const clave = new URL(url).pathname;
      expect(input.headers.get('if-none-match')).toBe('*');
      subidas.push(clave);
      if (objetos.has(clave)) return new Response('', { status: 412 });
      if (respuestas.r2 === 200) objetos.add(clave);
      if (aceptarSinRespuesta) {
        aceptarSinRespuesta = false;
        throw new DOMException('respuesta perdida', 'TimeoutError');
      }
      return new Response('', { status: respuestas.r2 });
    }
    throw new Error('La prueba intentó un transporte no simulado');
  });
});
afterEach(() => { salir?.(); jest.restoreAllMocks(); });

describe('F06-R1: PostgreSQL real y transportes externos controlados', () => {
  it('A: persiste pendiente, destruye/recrea service y recupera sin otro webhook', async () => {
    let anterior: Worker | undefined = worker();
    const mensaje = await recibir(ingesta(anterior));
    const inicial = await estado(mensaje.id);
    expect(inicial).toMatchObject({ estado: 'PENDIENTE', mediaId: 'media-f06', intentos: 0 });
    anterior.onModuleDestroy();
    anterior = undefined;
    // Otro Prisma: ni siquiera comparte el pool de conexiones de la primera instancia.
    const nuevo = worker(otroPrisma);
    expect(await nuevo.barrerPendientes()).toBe(1);
    expect(await estado(mensaje.id)).toMatchObject({ estado: 'COMPLETADO', intentos: 1, proximoIntento: null });
    expect((await prisma.mensaje.findUniqueOrThrow({ where: { id: mensaje.id } })).mediaKey)
      .toBe(`wa/${mensaje.conversacionId}/${mensaje.id}`);
    expect(subidas).toEqual([`/f06-bucket/wa/${mensaje.conversacionId}/${mensaje.id}`]);
    expect(gateway.notificarEntrante).toHaveBeenCalledTimes(1);
  });

  it('B: dos conexiones reclaman el MISMO id mientras la primera está dentro de Meta', async () => {
    const { mensaje } = await pendiente();
    const dentro = new Promise<void>(resolve => { entrada = resolve; });
    puerta = new Promise<void>(resolve => { salir = resolve; });
    const primero = worker().procesarUno(mensaje.id);
    try {
      await dentro;
      expect((await estado(mensaje.id)).estado).toBe('PROCESANDO');
      // Incluso adelantando el reloj, el lock no es una lease que se pueda robar.
      reloj = new Date(reloj.getTime() + 120_000);
      expect(await worker(otroPrisma).procesarUno(mensaje.id)).toBe(false);
      expect(llamadasOrigen).toBe(1);
    } finally { salir!(); }
    expect(await primero).toBe(true);
    expect(subidas).toHaveLength(1);
    expect((await estado(mensaje.id)).intentos).toBe(1);
  });

  it.each(['http', 'red', 'timeout', 'descarga'] as const)('C: Meta falla (%s), agenda y completa después', async fallo => {
    const { mensaje } = await pendiente();
    if (fallo === 'http') respuestas.origen = 503;
    if (fallo === 'descarga') respuestas.descarga = 503;
    if (fallo === 'red' || fallo === 'timeout') modo = fallo;
    const s = worker();
    await s.barrerPendientes();
    const t = await estado(mensaje.id);
    expect(t).toMatchObject({ estado: 'REINTENTABLE', intentos: 1 });
    expect(t.proximoIntento!.getTime() - reloj.getTime()).toBe(60_000);
    expect(t.ultimoError).not.toMatch(/secreto|token|https|firma/);
    expect(subidas).toHaveLength(0);
    expect(await s.barrerPendientes()).toBe(0);
    await habilitarReintento(mensaje.id);
    respuestas.origen = 200; respuestas.descarga = 200; modo = 'normal';
    await worker(otroPrisma).barrerPendientes();
    expect(await estado(mensaje.id)).toMatchObject({ estado: 'COMPLETADO', intentos: 2, ultimoError: null });
    expect(subidas).toHaveLength(1);
  });

  it('D: R2 503 conserva la tarea y converge a la misma clave en el reintento', async () => {
    const { mensaje } = await pendiente();
    respuestas.r2 = 503;
    await worker().barrerPendientes();
    expect(await estado(mensaje.id)).toMatchObject({ estado: 'REINTENTABLE', ultimoError: 'R2_HTTP_503' });
    expect((await prisma.mensaje.findUniqueOrThrow({ where: { id: mensaje.id } })).mediaKey).toBeNull();
    await habilitarReintento(mensaje.id);
    respuestas.r2 = 200;
    await worker(otroPrisma).barrerPendientes();
    expect((await estado(mensaje.id)).estado).toBe('COMPLETADO');
    expect(subidas).toHaveLength(2);
    expect(new Set(subidas).size).toBe(1);
  });

  it('E: duplicados mientras está pendiente/procesando no duplican fila, trabajo, subida ni push', async () => {
    const s = ingesta();
    const mensaje = await recibir(s);
    const dentro = new Promise<void>(resolve => { entrada = resolve; });
    puerta = new Promise<void>(resolve => { salir = resolve; });
    const proceso = worker().procesarUno(mensaje.id);
    try {
      await dentro;
      await Promise.all([recibir(s), recibir(s), recibir(s)]);
      expect(await prisma.mensaje.count({ where: { whatsappMsgId: 'wamid.f06' } })).toBe(1);
      expect(await prisma.trabajoMediaEntrante.count({ where: { mensajeId: mensaje.id } })).toBe(1);
      expect(gateway.notificarEntrante).toHaveBeenCalledTimes(1);
      expect(llamadasOrigen).toBe(1);
    } finally { salir!(); }
    await proceso;
    await recibir(s);
    expect(await worker(otroPrisma).barrerPendientes()).toBe(0);
    expect(subidas).toHaveLength(1);
    expect(gateway.notificarEntrante).toHaveBeenCalledTimes(1);
  });

  it.each(['tamano', 'origen404'] as const)('F: permanente %s queda descartado y no vuelve a ejecutarse', async fallo => {
    const { mensaje } = await pendiente();
    respuestas.grande = fallo === 'tamano';
    if (fallo === 'origen404') respuestas.origen = 404;
    await worker().barrerPendientes();
    expect(await estado(mensaje.id)).toMatchObject({ estado: 'DESCARTADO', proximoIntento: null, intentos: 1 });
    reloj = new Date(reloj.getTime() + PLAZO_MEDIA_MS * 2);
    expect(await worker(otroPrisma).barrerPendientes()).toBe(0);
    expect(subidas).toHaveLength(0);
  });

  it('un estado PROCESANDO sobreviviente se recupera con otro service/conexión', async () => {
    const { mensaje } = await pendiente();
    await prisma.trabajoMediaEntrante.update({
      where: { mensajeId: mensaje.id },
      data: { estado: 'PROCESANDO', intentos: 1, reclamadoEn: new Date(0), proximoIntento: new Date(0) },
    });
    await worker(otroPrisma).barrerPendientes();
    expect(await estado(mensaje.id)).toMatchObject({ estado: 'COMPLETADO', intentos: 2 });
  });

  it('sin R2 configurado conserva origen, espera una hora, luego recupera sin webhook', async () => {
    const { mensaje } = await pendiente();
    await worker(prisma, new R2Service(new ConfigService({}))).barrerPendientes();
    expect(await estado(mensaje.id)).toMatchObject({ estado: 'REINTENTABLE', intentos: 0, ultimoError: 'R2_SIN_CONFIGURAR' });
    expect((await estado(mensaje.id)).proximoIntento!.getTime() - reloj.getTime()).toBe(3_600_000);
    expect(llamadasOrigen).toBe(0);
    await habilitarReintento(mensaje.id);
    await worker(otroPrisma).barrerPendientes();
    expect((await estado(mensaje.id)).estado).toBe('COMPLETADO');
  });

  it.each(['linea', 'meta403', 'r2403'] as const)('configuración incompleta (%s) no consume intentos', async fallo => {
    const { mensaje } = await pendiente();
    if (fallo === 'linea') await prisma.lineaWhatsapp.update({ where: { id: LINEA }, data: { activa: false } });
    if (fallo === 'meta403') respuestas.origen = 403;
    if (fallo === 'r2403') respuestas.r2 = 403;
    await worker().barrerPendientes();
    expect(await estado(mensaje.id)).toMatchObject({ estado: 'REINTENTABLE', intentos: 0 });
    await habilitarReintento(mensaje.id);
    respuestas.origen = 200; respuestas.r2 = 200;
    await prisma.lineaWhatsapp.update({ where: { id: LINEA }, data: { activa: true } });
    await worker(otroPrisma).barrerPendientes();
    expect((await estado(mensaje.id)).estado).toBe('COMPLETADO');
  });

  it('ocho intentos fallidos terminan AGOTADO y preservan el último motivo sanitizado', async () => {
    const { mensaje } = await pendiente();
    respuestas.origen = 503;
    const esperas = [1, 5, 15, 60, 180, 360, 720];
    for (let n = 1; n <= 8; n++) {
      await worker().barrerPendientes();
      const t = await estado(mensaje.id);
      expect(t.intentos).toBe(n);
      if (n < 8) {
        expect(t.proximoIntento!.getTime() - reloj.getTime()).toBe(esperas[n - 1]! * 60_000);
        await habilitarReintento(mensaje.id);
      }
    }
    expect(await estado(mensaje.id)).toMatchObject({
      estado: 'AGOTADO', proximoIntento: null, ultimoError: 'INTENTOS_AGOTADOS:META_ORIGEN_HTTP_503',
    });
    expect(await worker().barrerPendientes()).toBe(0);
  });

  it('el plazo de siete días termina también la espera por configuración', async () => {
    const { mensaje, trabajo } = await pendiente();
    reloj = new Date(trabajo.createdAt.getTime() + PLAZO_MEDIA_MS);
    await worker().barrerPendientes();
    expect(await estado(mensaje.id)).toMatchObject({ estado: 'AGOTADO', ultimoError: 'PLAZO_AGOTADO', intentos: 0 });
    expect(llamadasOrigen).toBe(0);
  });

  it('fallo al guardar el trabajo revierte Mensaje y conserva 503 + aislamiento del lote', async () => {
    const s = ingesta();
    const controller = new WhatsappWebhookController(config, {} as ConversacionesService, s,
      {} as AlertasWhatsappService, new LineasWhatsappService(prisma, config));
    jest.spyOn(controller['logger'], 'error').mockImplementation(() => undefined);
    const payload = { entry: [{ changes: [{ value: {
      metadata: { phone_number_id: PHONE },
      messages: [
        { id: 'wamid.f06.mal', from: '59179000001', type: 'image', image: { id: 'x'.repeat(256), mime_type: 'image/jpeg' } },
        { id: 'wamid.f06.bien', from: '59179000001', type: 'image', image: { id: 'media-valida', mime_type: 'image/jpeg' } },
      ],
    } }] }] };
    await expect(controller.recibir(payload)).rejects.toThrow(ServiceUnavailableException);
    expect(await prisma.mensaje.count({ where: { whatsappMsgId: 'wamid.f06.mal' } })).toBe(0);
    const bueno = await prisma.mensaje.findUniqueOrThrow({ where: { whatsappMsgId: 'wamid.f06.bien' } });
    expect(await estado(bueno.id)).toMatchObject({ estado: 'PENDIENTE', mediaId: 'media-valida' });
    expect(gateway.notificarEntrante).toHaveBeenCalledTimes(1);
  });


  it('limita cada lote a diez y mantiene como máximo dos descargas en paralelo', async () => {
    const s = ingesta();
    for (let i = 0; i < 11; i++) await recibir(s, `wamid.f06.lote.${i}`);
    const dosDentro = new Promise<void>(resolve => { entrada = () => { if (llamadasOrigen === 2) resolve(); }; });
    puerta = new Promise<void>(resolve => { salir = resolve; });
    const w = worker();
    const barrido = w.barrerPendientes();
    try {
      await dosDentro;
      expect(llamadasOrigen).toBe(2);
      expect(await w.barrerPendientes()).toBe(0);
      expect(await prisma.trabajoMediaEntrante.count({ where: { estado: 'PROCESANDO' } })).toBe(2);
    } finally { salir!(); }
    expect(await barrido).toBe(10);
    expect(llamadasOrigen).toBe(10);
    expect(await w.resumen()).toMatchObject({ COMPLETADO: 10, PENDIENTE: 1 });
    expect(await w.barrerPendientes()).toBe(1);
    expect(objetos.size).toBe(11);
  });


  it('apagar el worker cancela su tanda y no inicia la siguiente; otro recupera los tres trabajos', async () => {
    const s = ingesta();
    for (let i = 0; i < 3; i++) await recibir(s, `wamid.f06.apagado.${i}`);
    const dosDentro = new Promise<void>(resolve => { entrada = () => { if (llamadasOrigen === 2) resolve(); }; });
    puerta = new Promise<void>(resolve => { salir = resolve; });
    const w = worker();
    const barrido = w.barrerPendientes();
    try {
      await dosDentro;
      w.onModuleDestroy();
    } finally { salir!(); }
    expect(await barrido).toBe(2);
    expect(llamadasOrigen).toBe(2);
    expect(subidas).toHaveLength(0);
    expect(await w.resumen()).toMatchObject({ REINTENTABLE: 2, PENDIENTE: 1 });
    reloj = new Date(reloj.getTime() + 120_000);
    expect(await worker(otroPrisma).barrerPendientes()).toBe(3);
    expect(objetos.size).toBe(3);
  });

  it('R2 aceptó pero se perdió la respuesta: el siguiente PUT condicional converge sin sobrescribir', async () => {
    const { mensaje } = await pendiente();
    aceptarSinRespuesta = true;
    await worker().barrerPendientes();
    expect(await estado(mensaje.id)).toMatchObject({ estado: 'REINTENTABLE', ultimoError: 'TIEMPO_AGOTADO' });
    expect(objetos.size).toBe(1);
    await habilitarReintento(mensaje.id);
    await worker(otroPrisma).barrerPendientes();
    expect((await estado(mensaje.id)).estado).toBe('COMPLETADO');
    expect(subidas).toHaveLength(2);
    expect(objetos.size).toBe(1);
  });

  it('caída de persistencia después del PUT: no confirma COMPLETADO sin mediaKey', async () => {
    const { mensaje } = await pendiente();
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION f06_fallar_media() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'fallo ficticio despues de PUT'; END $$`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER f06_fallar_media BEFORE UPDATE OF "mediaKey" ON "Mensaje"
      FOR EACH ROW EXECUTE FUNCTION f06_fallar_media()`);
    try {
      await worker().barrerPendientes();
      expect((await estado(mensaje.id)).estado).toBe('PROCESANDO');
      expect((await prisma.mensaje.findUniqueOrThrow({ where: { id: mensaje.id } })).mediaKey).toBeNull();
      expect(objetos.size).toBe(1);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER f06_fallar_media ON "Mensaje"');
      await prisma.$executeRawUnsafe('DROP FUNCTION f06_fallar_media()');
    }
    await habilitarReintento(mensaje.id);
    await worker(otroPrisma).barrerPendientes();
    expect((await estado(mensaje.id)).estado).toBe('COMPLETADO');
    expect(objetos.size).toBe(1);
  });

  it('perder la conexión del lock permite recuperar y el worker anterior no pisa al sucesor', async () => {
    const { mensaje } = await pendiente();
    const dentro = new Promise<void>(resolve => { entrada = resolve; });
    puerta = new Promise<void>(resolve => { salir = resolve; });
    const primero = worker().procesarUno(mensaje.id);
    try {
      await dentro;
      const [conexion] = await otroPrisma.$queryRaw<Array<{ pid: number }>>`
        SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND state = 'idle in transaction'
          AND query LIKE '%pg_try_advisory_xact_lock%' AND pid <> pg_backend_pid()
      `;
      expect(conexion).toBeDefined();
      await otroPrisma.$queryRaw`SELECT pg_terminate_backend(${conexion!.pid})`;
      reloj = new Date(reloj.getTime() + 120_000);
      puerta = undefined; // solo el primer fetch conserva la promesa pausada
      expect(await worker(otroPrisma).procesarUno(mensaje.id)).toBe(true);
      expect((await estado(mensaje.id)).estado).toBe('COMPLETADO');
    } finally { salir!(); }
    expect(await primero).toBe(false);
    expect((await estado(mensaje.id)).estado).toBe('COMPLETADO');
    expect(subidas).toHaveLength(1);
  });


  it('el presupuesto de 60 s cancela la red en vuelo y agenda recuperación', async () => {
    const { mensaje } = await pendiente();
    const limite = new AbortController();
    const timeout = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(limite.signal);
    let entro!: () => void;
    const dentro = new Promise<void>(resolve => { entro = resolve; });
    jest.mocked(fetch).mockImplementationOnce(async (_input, init) => {
      entro();
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
      });
    });
    const intento = worker().procesarUno(mensaje.id);
    await dentro;
    expect(timeout).toHaveBeenCalledWith(60_000);
    limite.abort(new DOMException('presupuesto agotado', 'TimeoutError'));
    await intento;
    expect(await estado(mensaje.id)).toMatchObject({ estado: 'REINTENTABLE', ultimoError: 'TIEMPO_AGOTADO', intentos: 1 });
    expect(subidas).toHaveLength(0);
    timeout.mockRestore();
    await habilitarReintento(mensaje.id);
    await worker(otroPrisma).barrerPendientes();
    expect((await estado(mensaje.id)).estado).toBe('COMPLETADO');
  });

  it('un fallo de refresco WebSocket después del commit no reabre ni vuelve a subir media', async () => {
    const { mensaje } = await pendiente();
    gateway.emitirActividad.mockImplementationOnce(() => { throw new Error('socket caido'); });
    expect(await worker().procesarUno(mensaje.id)).toBe(true);
    expect((await estado(mensaje.id)).estado).toBe('COMPLETADO');
    expect(await worker(otroPrisma).barrerPendientes()).toBe(0);
    expect(subidas).toHaveLength(1);
    expect(gateway.notificarEntrante).toHaveBeenCalledTimes(1);
  });

  it('PK, FK, checks e índice existen; no acepta dos trabajos ni elimina sin cascada', async () => {
    const { mensaje } = await pendiente();
    await expect(prisma.trabajoMediaEntrante.create({ data: { mensajeId: mensaje.id, mediaId: 'otra' } }))
      .rejects.toMatchObject({ code: 'P2002' });
    await expect(prisma.trabajoMediaEntrante.create({ data: { mensajeId: 'inexistente', mediaId: 'otra' } }))
      .rejects.toMatchObject({ code: 'P2003' });
    await expect(prisma.trabajoMediaEntrante.update({ where: { mensajeId: mensaje.id }, data: { estado: 'INVENTADO' } }))
      .rejects.toThrow();
    await expect(prisma.trabajoMediaEntrante.update({ where: { mensajeId: mensaje.id }, data: { proximoIntento: null } }))
      .rejects.toThrow();
    const indices = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'TrabajoMediaEntrante'
    `;
    expect(indices.map(i => i.indexname)).toEqual(expect.arrayContaining([
      'TrabajoMediaEntrante_pkey', 'TrabajoMediaEntrante_proximoIntento_mensajeId_idx',
    ]));
    expect(await worker().resumen()).toMatchObject({ PENDIENTE: 1 });
    await prisma.mensaje.delete({ where: { id: mensaje.id } });
    expect(await prisma.trabajoMediaEntrante.count({ where: { mensajeId: mensaje.id } })).toBe(0);
  });
});
