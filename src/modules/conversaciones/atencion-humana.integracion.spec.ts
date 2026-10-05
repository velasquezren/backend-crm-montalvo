import { INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { createHmac, randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { MetaSignatureGuard } from '../../common/guards/meta-signature.guard';
import { PushService } from '../../common/push/push.service';
import { R2Service } from '../../common/storage/r2.service';
import { WhatsappCloudService, ResultadoEnvio } from '../../common/whatsapp/whatsapp-cloud.service';
import { AlertasWhatsappService } from '../../common/whatsapp/alertas-whatsapp.service';
import { AuthService } from '../auth/auth.service';
import { UsuariosService } from '../usuarios/usuarios.service';
import { ClientesService } from '../clientes/clientes.service';
import { CategoriaPacienteService } from '../clientes/categoria-paciente.service';
import { ServiciosService } from '../servicios/servicios.service';
import { TipoCambioService } from '../tipo-cambio/tipo-cambio.service';
import { LineasWhatsappService } from '../lineas-whatsapp/lineas-whatsapp.service';
import { PrimerContactoService } from '../leads/primer-contacto.service';
import { MemoriaAgenteService } from '../memoria-agente/memoria-agente.service';
import { Rol } from '../../prisma/prisma-client';
import { ConversacionesService } from './conversaciones.service';
import { EnvioPlantillasService } from './envio-plantillas.service';
import { AtencionHumanaService } from './atencion-humana.service';
import { ConversacionesController } from './conversaciones.controller';
import { ConversacionesGateway } from './conversaciones.gateway';
import { IngestaWhatsappService } from './ingesta-whatsapp.service';
import { AcuseAutomaticoService } from './acuse-automatico.service';
import { DespachadorSalienteService } from './despachador-saliente.service';
import { MediaEntranteService } from './media-entrante.service';
import { ReintentoSalienteService } from './reintento-saliente.service';
import { CierreInactividadService } from './cierre-inactividad.service';
import { WhatsappWebhookController } from './webhooks/whatsapp-webhook.controller';
import { datosOferta, OfertaInteraccion } from './interacciones-integracion';
import * as atencionHumana from './atencion-humana';

/*
 * Atención humana de punta a punta (docs/atencion-humana.md): webhook firmado,
 * ingesta, Postgres real, HTTP con los guards reales y Socket.IO. Meta es lo
 * único simulado: ningún mensaje sale de esta máquina.
 */

// URL deliberadamente fija; nunca usar DATABASE_URL ni cargar .env en esta suite.
const prisma = new PrismaService('postgresql://crm_app@127.0.0.1:5433/crm_test');
const claveSintetica = Buffer.alloc(32, 9).toString('base64');
const secretoSintetico = 'firma-webhook-sintetica-atencion';
const transporte = { enviar: jest.fn<Promise<ResultadoEnvio>, unknown[]>(), listarPlantillas: jest.fn() };
/* Acuse SIEMPRE fuera de horario (un minuto de domingo) y ubicación encendida:
   así cada prueba puede demostrar que la automatización habría hablado. */
const config = new ConfigService({
  META_APP_SECRET: secretoSintetico,
  AUTORESPUESTA_TEXTO: 'Acuse sintético: te respondemos en horario de atención.',
  AUTORESPUESTA_HORARIO: 'D:03:00-03:01',
  UBICACION_AUTOMATICA: 'on',
});

@Module({
  imports: [JwtModule.register({ secret: 'jwt-sintetico-atencion', signOptions: { expiresIn: '15m' } })],
  controllers: [ConversacionesController, WhatsappWebhookController],
  providers: [
    { provide: PrismaService, useValue: prisma }, { provide: ConfigService, useValue: config },
    AuditService, AuthService, UsuariosService, ClientesService, CategoriaPacienteService, ServiciosService, TipoCambioService,
    LineasWhatsappService, PrimerContactoService, MemoriaAgenteService, ConversacionesService, EnvioPlantillasService, AtencionHumanaService,
    ConversacionesGateway, IngestaWhatsappService, AcuseAutomaticoService, DespachadorSalienteService,
    ReintentoSalienteService, CierreInactividadService, MetaSignatureGuard,
    { provide: WhatsappCloudService, useValue: transporte },
    { provide: R2Service, useValue: { urlFirmada: async () => null } },
    { provide: PushService, useValue: { enviarAUsuario: async () => undefined } },
    { provide: AlertasWhatsappService, useValue: { procesar: async () => undefined } },
    { provide: MediaEntranteService, useValue: { despertar: () => undefined } },
    { provide: APP_GUARD, useClass: JwtAuthGuard }, { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
class ModuloAtencionTest {}

const PREFIJO_TEL = '+591700027';
const telefono = `${PREFIJO_TEL}01`;
const PHONE_RECEPCION = 'meta-atencion-recepcion';
const PHONE_COMERCIAL = 'meta-atencion-comercial';
const envOriginal = { flag: process.env['WHATSAPP_INTERACCIONES'], key: process.env['WHATSAPP_INTERACCIONES_KEY'] };

let app: INestApplication;
let base: string;
let recepcion: string;
let comercial: string;
let paciente: string;
let chat: string;
let chatComercial: string;
const usuarios: Record<'rec1' | 'rec2' | 'sinLinea' | 'ventasA' | 'ventasB', { id: string; token: string }> = {} as never;

async function crearApp(): Promise<INestApplication> {
  const nueva = await NestFactory.create(ModuloAtencionTest, { rawBody: true, logger: false, abortOnError: false });
  nueva.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await nueva.listen(0, '127.0.0.1');
  return nueva;
}
async function http(ruta: string, metodo = 'GET', bearer = usuarios.rec1.token, cuerpo?: unknown, raiz = base) {
  const r = await fetch(raiz + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}
async function webhook(mensajes: unknown[], phoneId = PHONE_RECEPCION) {
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: phoneId }, messages: mensajes } }] }] });
  return fetch(base + '/webhooks/whatsapp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', secretoSintetico).update(body).digest('hex')}` },
    body,
  });
}
const ahoraMeta = () => String(Math.floor(Date.now() / 1000));
function toque(contexto: string, opcion = 'TALK_TO_HUMAN', id = `wamid.in.${randomUUID()}`) {
  return { id, from: telefono.slice(1), type: 'interactive', timestamp: ahoraMeta(), context: { id: contexto }, interactive: { type: 'button_reply', button_reply: { id: opcion, title: 'Título que manda el teléfono' } } };
}
function texto(cuerpo: string, id = `wamid.in.${randomUUID()}`) {
  return { id, from: telefono.slice(1), type: 'text', timestamp: ahoraMeta(), text: { body: cuerpo } };
}
/** Una oferta de botones nuestra ya enviada, como la deja el despachador. */
async function ofrecerBotones(conversacionId = chat) {
  const clientMessageId = randomUUID();
  const oferta: OfertaInteraccion = {
    telefono,
    mensaje: { tipo: 'botones', cuerpo: '¿Cómo podemos ayudarte?', opciones: [
      { id: 'BOOK_APPOINTMENT', titulo: 'Solicitar cita' },
      { id: 'VIEW_SERVICES', titulo: 'Servicios y precios' },
      { id: 'TALK_TO_HUMAN', titulo: 'Hablar con recepción' },
    ] },
  };
  return prisma.mensaje.create({ data: {
    conversacionId, direccion: 'SALIENTE', contenido: oferta.mensaje.cuerpo, clientMessageId,
    whatsappMsgId: `wamid.out.${randomUUID()}`, interaccion: { create: datosOferta(oferta, clientMessageId) },
  } });
}
async function conversacion(id = chat) {
  return prisma.conversacion.findUniqueOrThrow({ where: { id } });
}
async function esperar(condicion: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 150; i++) { if (await condicion()) return; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('La condición no se cumplió a tiempo');
}
/** Deja terminar lo que la ingesta dispara en segundo plano (acuse, ubicación). */
const reposo = () => new Promise(r => setTimeout(r, 250));
const automaticos = (conversacionId = chat) => prisma.mensaje.count({ where: { conversacionId, automatico: true } });

async function limpiar() {
  await prisma.cliente.deleteMany({ where: { telefono: { startsWith: PREFIJO_TEL } } });
  const ids = (await prisma.usuario.findMany({ where: { email: { endsWith: '@atencion.test' } }, select: { id: true } })).map(u => u.id);
  await prisma.auditLog.deleteMany({ where: { OR: [{ usuarioId: { in: ids } }, { entidad: 'Conversacion', accion: { startsWith: 'ATENCION_' } }] } });
  await prisma.usuario.deleteMany({ where: { id: { in: ids } } });
  await prisma.lineaWhatsapp.deleteMany({ where: { nombre: { startsWith: 'ATENCION-' } } });
}

beforeAll(async () => {
  process.env['WHATSAPP_INTERACCIONES'] = 'on';
  process.env['WHATSAPP_INTERACCIONES_KEY'] = claveSintetica;
  app = await crearApp();
  base = await app.getUrl();
}, 30_000);

beforeEach(async () => {
  process.env['WHATSAPP_INTERACCIONES'] = 'on';
  process.env['WHATSAPP_INTERACCIONES_KEY'] = claveSintetica;
  await limpiar();
  transporte.enviar.mockReset().mockImplementation(async () => ({ estado: 'ENVIADO', metaMsgId: `wamid.out.${randomUUID()}` }));
  recepcion = (await prisma.lineaWhatsapp.create({ data: { nombre: 'ATENCION-recepcion', telefono: '+59170002791', phoneNumberId: PHONE_RECEPCION, tokenEnv: 'TOKEN_INEXISTENTE_ATENCION', comercial: false } })).id;
  comercial = (await prisma.lineaWhatsapp.create({ data: { nombre: 'ATENCION-comercial', telefono: '+59170002792', phoneNumberId: PHONE_COMERCIAL, tokenEnv: 'TOKEN_INEXISTENTE_ATENCION', comercial: true } })).id;
  const definiciones: [keyof typeof usuarios, Rol, string[]][] = [
    ['rec1', 'RECEPCION', [recepcion]], ['rec2', 'RECEPCION', [recepcion]], ['sinLinea', 'RECEPCION', []],
    ['ventasA', 'AGENTE', [comercial]], ['ventasB', 'AGENTE', [comercial]],
  ];
  for (const [clave, rol, lineas] of definiciones) {
    const u = await prisma.usuario.create({ data: {
      nombre: `Persona ${clave}`, email: `${clave}@atencion.test`, passwordHash: await bcrypt.hash('sintetico', 4), rol, activo: true,
      lineasWhatsapp: { create: lineas.map(lineaId => ({ lineaId })) },
    } });
    usuarios[clave] = { id: u.id, token: (await app.get(AuthService).login({ email: u.email, password: 'sintetico' })).access_token };
  }
  paciente = (await prisma.cliente.create({ data: { nombre: 'Paciente sintética', telefono } })).id;
  chat = (await prisma.conversacion.create({ data: { clienteId: paciente, lineaId: recepcion } })).id;
  chatComercial = (await prisma.conversacion.create({ data: { clienteId: paciente, lineaId: comercial } })).id;
  /* Abre la ventana de 24 h, como lo haría su primer mensaje. */
  await prisma.mensaje.createMany({ data: [
    { conversacionId: chat, direccion: 'ENTRANTE', contenido: 'Hola' },
    { conversacionId: chatComercial, direccion: 'ENTRANTE', contenido: 'Hola' },
  ] });
});

afterAll(async () => {
  await limpiar(); await app?.close(); await prisma.$disconnect();
  for (const [nombre, valor] of [['WHATSAPP_INTERACCIONES', envOriginal.flag], ['WHATSAPP_INTERACCIONES_KEY', envOriginal.key]] as const) {
    if (valor === undefined) delete process.env[nombre]; else process.env[nombre] = valor;
  }
});

describe('A · «Hablar con recepción»', () => {
  it('queda una solicitud persistente, en la pestaña y en su contador, y la automatización se calla', async () => {
    /* Control: sin solicitud, preguntar la dirección SÍ dispara la ubicación automática. */
    expect((await webhook([texto('¿dónde queda la clínica?')])).status).toBe(200);
    await esperar(async () => (await automaticos()) > 0);
    const antes = await automaticos();

    const oferta = await ofrecerBotones();
    expect((await webhook([toque(oferta.whatsappMsgId!)])).status).toBe(200);

    const c = await conversacion();
    expect(c.atencionSolicitadaEn).not.toBeNull();
    expect(c.atencionMotivo).toBe('SOLICITUD_EXPLICITA');
    expect(c.atencionTomadaEn).toBeNull();
    expect(c.automatizacionPausadaEn).not.toBeNull();
    expect(c.agenteId).toBeNull();

    const lista = await http('/conversaciones?tab=ATENCION');
    expect(lista.status).toBe(200);
    const datos = lista.body['datos'] as { id: string; atencion: { estado: string; prioridad: string; motivo: string } }[];
    expect(datos.map(d => d.id)).toEqual([chat]);
    expect(datos[0].atencion).toMatchObject({ estado: 'ESPERANDO', prioridad: 'ALTA', motivo: 'SOLICITUD_EXPLICITA' });
    expect(lista.body['contadores']).toMatchObject({ esperandoHumano: 1, enAtencion: 0 });

    /* La misma pregunta ya no recibe nada automático. */
    expect((await webhook([texto('¿dónde queda la clínica?')])).status).toBe(200);
    await reposo();
    expect(await automaticos()).toBe(antes);
  });
});

describe('B · recepción compartida', () => {
  it('las dos ven la solicitud, una la toma, todas lo ven en vivo y el chat no se asigna', async () => {
    const oferta = await ofrecerBotones();
    await webhook([toque(oferta.whatsappMsgId!)]);

    for (const u of [usuarios.rec1, usuarios.rec2]) {
      const r = await http('/conversaciones?tab=ATENCION', 'GET', u.token);
      expect((r.body['datos'] as { id: string }[]).map(d => d.id)).toContain(chat);
    }

    /* rec2 escucha el socket mientras rec1 toma. */
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/socket.io/?EIO=4&transport=websocket');
    const eventos: string[] = [];
    let conectado = false;
    ws.addEventListener('message', event => {
      const data = String(event.data);
      if (data.startsWith('0')) ws.send(`40/realtime,${JSON.stringify({ token: usuarios.rec2.token })}`);
      if (data.startsWith('40/realtime,')) conectado = true;
      if (data === '2') ws.send('3');
      if (data.startsWith('42/realtime,')) eventos.push(data);
    });
    try {
      await esperar(async () => conectado);
      const tomada = await http(`/conversaciones/${chat}/atencion/tomar`, 'POST', usuarios.rec1.token);
      expect(tomada.status).toBe(201);
      expect(tomada.body).toMatchObject({ estado: 'EN_ATENCION', tomadaPor: { id: usuarios.rec1.id } });
      await esperar(async () => eventos.some(e => e.includes('conversacion:actividad') && e.includes(chat)));
    } finally { ws.close(); }

    const vista = await http(`/conversaciones/${chat}`, 'GET', usuarios.rec2.token);
    expect(vista.body['atencion']).toMatchObject({ estado: 'EN_ATENCION', tomadaPor: { nombre: 'Persona rec1' } });
    expect((await conversacion()).agenteId).toBeNull();
    const contadores = (await http('/conversaciones?tab=ATENCION', 'GET', usuarios.rec2.token)).body['contadores'];
    expect(contadores).toMatchObject({ esperandoHumano: 0, enAtencion: 1 });

    const segunda = await http(`/conversaciones/${chat}/atencion/tomar`, 'POST', usuarios.rec2.token);
    expect(segunda.status).toBe(409);
    expect(String(segunda.body['message'])).toContain('Persona rec1');
    /* Idempotente para quien ya la tiene. */
    expect((await http(`/conversaciones/${chat}/atencion/tomar`, 'POST', usuarios.rec1.token)).status).toBe(201);
    expect(await prisma.auditLog.count({ where: { entidadId: chat, accion: 'ATENCION_TOMADA' } })).toBe(1);
  });

  it('liberar la devuelve a la espera sin reiniciar el reloj; solo quien la tomó', async () => {
    const oferta = await ofrecerBotones();
    await webhook([toque(oferta.whatsappMsgId!)]);
    const { atencionSolicitadaEn } = await conversacion();
    await http(`/conversaciones/${chat}/atencion/tomar`, 'POST', usuarios.rec1.token);

    expect((await http(`/conversaciones/${chat}/atencion/liberar`, 'POST', usuarios.rec2.token)).status).toBe(403);
    expect((await http(`/conversaciones/${chat}/atencion/liberar`, 'POST', usuarios.rec1.token)).body).toMatchObject({ estado: 'ESPERANDO', tomadaPor: null });
    expect((await conversacion()).atencionSolicitadaEn).toEqual(atencionSolicitadaEn);
  });

  it('contestar desde el chat toma la solicitud en espera', async () => {
    const oferta = await ofrecerBotones();
    await webhook([toque(oferta.whatsappMsgId!)]);
    const r = await http(`/conversaciones/${chat}/mensajes`, 'POST', usuarios.rec2.token, { contenido: 'Hola, te atiendo yo', clientMessageId: randomUUID() });
    expect(r.status).toBe(201);
    const c = await conversacion();
    expect(c.atencionTomadaPorId).toBe(usuarios.rec2.id);
    expect(c.agenteId).toBeNull();
  });
});

describe('C · línea comercial', () => {
  it('tomar reclama el chat del pool para quien toma, y la otra agente deja de verlo', async () => {
    const oferta = await ofrecerBotones(chatComercial);
    expect((await webhook([toque(oferta.whatsappMsgId!)], PHONE_COMERCIAL)).status).toBe(200);
    expect((await conversacion(chatComercial)).atencionMotivo).toBe('SOLICITUD_EXPLICITA');

    expect((await http(`/conversaciones/${chatComercial}/atencion/tomar`, 'POST', usuarios.ventasA.token)).status).toBe(201);
    expect((await conversacion(chatComercial)).agenteId).toBe(usuarios.ventasA.id);

    /* La regla comercial de siempre: el chat de otra agente no se ve ni se toca. */
    expect((await http(`/conversaciones/${chatComercial}`, 'GET', usuarios.ventasB.token)).status).toBe(404);
    expect((await http(`/conversaciones/${chatComercial}/atencion/liberar`, 'POST', usuarios.ventasB.token)).status).toBe(404);
  });

  it('tomar no le quita a nadie un chat ya asignado', async () => {
    await prisma.conversacion.update({ where: { id: chatComercial }, data: { agenteId: usuarios.ventasA.id } });
    const oferta = await ofrecerBotones(chatComercial);
    await webhook([toque(oferta.whatsappMsgId!)], PHONE_COMERCIAL);
    expect((await http(`/conversaciones/${chatComercial}/atencion/tomar`, 'POST', usuarios.ventasB.token)).status).toBe(404);
    expect((await conversacion(chatComercial)).agenteId).toBe(usuarios.ventasA.id);
  });
});

describe('D · Flow de solicitud de cita', () => {
  it('se ve con sus datos, queda pendiente, no es una cita ni es urgente', async () => {
    const clientMessageId = randomUUID();
    const oferta: OfertaInteraccion = {
      telefono,
      mensaje: { tipo: 'flow', cuerpo: 'Solicita tu cita', flowId: 'flow-cita', correlacion: 'token-cita', cta: 'Solicitar', modo: 'published', inicio: { accion: 'navigate', pantalla: 'CITA' } },
      flow: {
        id: 'flow-cita', version: 'v1', pantalla: 'CITA', proposito: 'SOLICITUD_CITA',
        respuestas: { especialidad: ['GINECOLOGIA', 'DERMATOLOGIA'], horario: ['MANANA', 'TARDE'] },
        campos: { fecha: { tipo: 'fecha' }, comentario: { tipo: 'texto', max: 200 } },
        etiquetas: { especialidad: 'Especialidad', fecha: 'Fecha preferida', horario: 'Horario preferido' },
        titulos: { especialidad: { GINECOLOGIA: 'Ginecología' }, horario: { TARDE: 'Tarde' } },
      },
    };
    const m = await prisma.mensaje.create({ data: { conversacionId: chat, direccion: 'SALIENTE', contenido: 'Solicita tu cita', clientMessageId, whatsappMsgId: `wamid.out.${randomUUID()}`, interaccion: { create: datosOferta(oferta, clientMessageId) } } });
    const respuesta = JSON.stringify({ flow_token: 'token-cita', flow_version: 'v1', especialidad: 'GINECOLOGIA', horario: 'TARDE', fecha: '2026-10-13', comentario: 'Dato libre privado' });
    const raw = { ...toque(m.whatsappMsgId!), interactive: { type: 'nfm_reply', nfm_reply: { name: 'flow', response_json: respuesta } } };
    expect((await webhook([raw])).status).toBe(200);

    const c = await conversacion();
    expect(c.atencionMotivo).toBe('SOLICITUD_CITA');
    const detalle = await http(`/conversaciones/${chat}`);
    const atencion = detalle.body['atencion'] as Record<string, unknown>;
    expect(atencion).toMatchObject({ estado: 'ESPERANDO', prioridad: 'NORMAL', motivo: 'SOLICITUD_CITA' });
    expect(atencion['origen']).toMatchObject({
      tipo: 'respuesta_flow',
      versionFlow: 'v1',
      datos: [
        { etiqueta: 'Especialidad', valor: 'Ginecología' },
        { etiqueta: 'Fecha preferida', valor: '2026-10-13' },
        { etiqueta: 'Horario preferido', valor: 'Tarde' },
      ],
    });
    const cuerpo = JSON.stringify(detalle.body);
    expect(cuerpo).toContain('no hay ninguna cita reservada');
    expect(cuerpo).not.toMatch(/confirmada|Dato libre privado|token-cita|response_json|nfm_reply/);
  });
});

describe('E · la paciente escribe después del traspaso', () => {
  it('su mensaje llega al personal y la automatización sigue callada', async () => {
    const oferta = await ofrecerBotones(chatComercial);
    await webhook([toque(oferta.whatsappMsgId!)], PHONE_COMERCIAL);
    /* Fuera de horario en la comercial: sin pausa, esto mandaría el acuse. */
    expect((await webhook([texto('¿me atienden?')], PHONE_COMERCIAL)).status).toBe(200);
    await reposo();
    expect(await automaticos(chatComercial)).toBe(0);
    const c = await conversacion(chatComercial);
    expect(c.esperandoRespuesta).toBe(true);
    expect(c.atencionSolicitadaEn).not.toBeNull();
    expect(await prisma.mensaje.count({ where: { conversacionId: chatComercial, contenido: '¿me atienden?' } })).toBe(1);
  });

  it('control: sin traspaso, ese mismo mensaje sí recibe el acuse', async () => {
    await webhook([texto('¿me atienden?')], PHONE_COMERCIAL);
    await esperar(async () => (await automaticos(chatComercial)) === 1);
  });
});

describe('F/G · recargar y reiniciar', () => {
  it('la solicitud y su reloj sobreviven a otra petición y a otro proceso', async () => {
    const oferta = await ofrecerBotones();
    await webhook([toque(oferta.whatsappMsgId!)]);
    const primera = (await http(`/conversaciones/${chat}`)).body['atencion'] as { solicitadaEn: string };
    await new Promise(r => setTimeout(r, 30));
    const recarga = (await http(`/conversaciones/${chat}`)).body['atencion'] as { solicitadaEn: string };
    expect(recarga.solicitadaEn).toBe(primera.solicitadaEn);

    const otra = await crearApp();
    try {
      const raiz = await otra.getUrl();
      const tras = await http('/conversaciones?tab=ATENCION', 'GET', usuarios.rec1.token, undefined, raiz);
      const fila = (tras.body['datos'] as { id: string; atencion: { solicitadaEn: string } }[])[0];
      expect(fila.id).toBe(chat);
      expect(fila.atencion.solicitadaEn).toBe(primera.solicitadaEn);
    } finally { await otra.close(); }
  });
});

describe('H · dos personas toman a la vez', () => {
  it('una transición válida, nunca dos', async () => {
    const oferta = await ofrecerBotones();
    await webhook([toque(oferta.whatsappMsgId!)]);
    const resultados = await Promise.all([usuarios.rec1, usuarios.rec2].map(u => http(`/conversaciones/${chat}/atencion/tomar`, 'POST', u.token)));
    expect(resultados.map(r => r.status).sort()).toEqual([201, 409]);
    const ganadora = resultados.find(r => r.status === 201)!.body['tomadaPor'] as { id: string };
    expect((await conversacion()).atencionTomadaPorId).toBe(ganadora.id);
    expect(await prisma.auditLog.count({ where: { entidadId: chat, accion: 'ATENCION_TOMADA' } })).toBe(1);
  });
});

describe('I · Meta repite la respuesta', () => {
  it('el mismo wamid y un segundo toque no duplican ni mueven el reloj', async () => {
    const oferta = await ofrecerBotones();
    const raw = toque(oferta.whatsappMsgId!);
    await Promise.all([webhook([raw]), webhook([raw])]);
    const { atencionSolicitadaEn } = await conversacion();
    expect(await prisma.mensaje.count({ where: { whatsappMsgId: raw.id } })).toBe(1);

    await webhook([toque(oferta.whatsappMsgId!)]);
    const c = await conversacion();
    expect(c.atencionSolicitadaEn).toEqual(atencionSolicitadaEn);
    expect(c.atencionMotivo).toBe('SOLICITUD_EXPLICITA');
    expect((await http('/conversaciones?tab=ATENCION')).body['contadores']).toMatchObject({ esperandoHumano: 1 });
  });

  it('una respuesta menos urgente no baja el motivo; una más urgente lo sube sin reiniciar el reloj', async () => {
    const oferta = await ofrecerBotones();
    await webhook([toque(oferta.whatsappMsgId!, 'VIEW_SERVICES')]);
    const primera = await conversacion();
    expect(primera.atencionMotivo).toBe('REVISION');

    const otra = await ofrecerBotones();
    await webhook([toque(otra.whatsappMsgId!, 'TALK_TO_HUMAN')]);
    const tras = await conversacion();
    expect(tras.atencionMotivo).toBe('SOLICITUD_EXPLICITA');
    expect(tras.atencionSolicitadaEn).toEqual(primera.atencionSolicitadaEn);
  });
});

describe('J · fallo temporal de PostgreSQL', () => {
  it('el lote responde 503, no queda nada a medias y el reintento de Meta lo recupera una sola vez', async () => {
    const oferta = await ofrecerBotones();
    const raw = toque(oferta.whatsappMsgId!);
    const espia = jest.spyOn(atencionHumana, 'registrarSolicitudAtencion').mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));
    try {
      expect((await webhook([raw])).status).toBe(503);
      expect(await prisma.mensaje.count({ where: { whatsappMsgId: raw.id } })).toBe(0);
      expect((await conversacion()).atencionSolicitadaEn).toBeNull();
    } finally { espia.mockRestore(); }

    expect((await webhook([raw])).status).toBe(200);
    expect(await prisma.mensaje.count({ where: { whatsappMsgId: raw.id } })).toBe(1);
    expect((await conversacion()).atencionMotivo).toBe('SOLICITUD_EXPLICITA');
  });
});

describe('K · sin permiso', () => {
  it('quien no tiene la línea no la ve ni la manipula', async () => {
    const oferta = await ofrecerBotones();
    await webhook([toque(oferta.whatsappMsgId!)]);
    const lista = await http('/conversaciones?tab=ATENCION', 'GET', usuarios.sinLinea.token);
    expect((lista.body['datos'] as unknown[]).length).toBe(0);
    expect(lista.body['contadores']).toMatchObject({ esperandoHumano: 0, enAtencion: 0 });
    for (const accion of ['tomar', 'liberar', 'resolver']) {
      expect((await http(`/conversaciones/${chat}/atencion/${accion}`, 'POST', usuarios.sinLinea.token)).status).toBe(404);
    }
    expect((await http(`/conversaciones/${chat}/automatizacion/reanudar`, 'POST', usuarios.sinLinea.token)).status).toBe(404);
    expect((await conversacion()).atencionTomadaEn).toBeNull();
  });
});

describe('L · nadie conectado', () => {
  it('la solicitud espera sin que a la paciente se le prometa nada', async () => {
    const oferta = await ofrecerBotones();
    transporte.enviar.mockClear();
    await webhook([toque(oferta.whatsappMsgId!)]);
    await reposo();
    expect(transporte.enviar).not.toHaveBeenCalled();
    expect(await automaticos()).toBe(0);
    expect((await conversacion()).atencionSolicitadaEn).not.toBeNull();
  });
});

describe('M · respuesta fuera de contexto', () => {
  it('no ejecuta nada: queda para revisión con la evidencia cifrada', async () => {
    transporte.enviar.mockClear();
    const raw = { ...toque('wamid.que.no.es.nuestro'), interactive: { type: 'nfm_reply', nfm_reply: { name: 'flow', response_json: JSON.stringify({ flow_token: 'inventado', flow_version: 'v1', accion: 'BORRAR_TODO' }) } } };
    expect((await webhook([raw])).status).toBe(200);
    const fila = await prisma.mensaje.findUniqueOrThrow({ where: { whatsappMsgId: raw.id }, include: { interaccion: true } });
    expect(fila.interaccion?.estado).toBe('NO_CORRELACIONADA');
    expect(fila.interaccion?.privado).toBeTruthy();
    const c = await conversacion();
    expect(c.atencionMotivo).toBe('REVISION');
    expect(c.agenteId).toBeNull();
    await reposo();
    expect(transporte.enviar).not.toHaveBeenCalled();
    const vista = JSON.stringify((await http(`/conversaciones/${chat}`)).body);
    expect(vista).not.toMatch(/BORRAR_TODO|inventado/);
  });

  it('un TALK_TO_HUMAN que no viene de nuestra oferta no cuenta como pedido explícito', async () => {
    await webhook([toque('wamid.ajeno')]);
    expect((await conversacion()).atencionMotivo).toBe('REVISION');
  });
});

describe('N · un automático en curso cuando alguien pide una persona', () => {
  it('lo guardado antes de la pausa se retira sin salir; después de la pausa ni se guarda', async () => {
    const ingesta = app.get(IngestaWhatsappService);
    /* Un automático guardado (el LLM del futuro ya «decidió»), aún sin despachar. */
    const filas = await ingesta['guardarMensajeAutomatico'](chat, ['Respuesta automática tardía'], async () => false);
    expect(filas).toHaveLength(1);

    const oferta = await ofrecerBotones();
    await webhook([toque(oferta.whatsappMsgId!)]);
    transporte.enviar.mockClear();

    expect(await ingesta['sigueSinPausa'](chat, filas!)).toBe(false);
    expect(await prisma.mensaje.count({ where: { id: filas![0].id } })).toBe(0);
    expect(transporte.enviar).not.toHaveBeenCalled();

    expect(await ingesta['guardarMensajeAutomatico'](chat, ['Otra'], async () => false)).toBeNull();
  });

  it('el barrido de reintentos no reenvía un automático de un chat pausado', async () => {
    const oferta = await ofrecerBotones();
    await webhook([toque(oferta.whatsappMsgId!)]);
    await prisma.mensaje.create({ data: {
      conversacionId: chat, direccion: 'SALIENTE', contenido: 'Automático que falló', automatico: true,
      estadoEnvio: 'FALLIDO', permiteReintento: true, proximoIntento: new Date(Date.now() - 1000),
    } });
    transporte.enviar.mockClear();
    await app.get(ReintentoSalienteService).barrerEnviosPendientes();
    expect(transporte.enviar).not.toHaveBeenCalled();
  });
});

describe('Resolver, cerrar y reanudar', () => {
  it('resolver la saca de «Atención»; la automatización solo vuelve con una reanudación explícita', async () => {
    const oferta = await ofrecerBotones();
    await webhook([toque(oferta.whatsappMsgId!)]);
    expect((await http(`/conversaciones/${chat}/automatizacion/reanudar`, 'POST')).status).toBe(409);

    expect((await http(`/conversaciones/${chat}/atencion/resolver`, 'POST')).body).toMatchObject({ estado: null });
    expect((await http(`/conversaciones/${chat}/atencion/resolver`, 'POST')).status).toBe(409);
    expect((await conversacion()).automatizacionPausadaEn).not.toBeNull();

    expect((await http(`/conversaciones/${chat}/automatizacion/reanudar`, 'POST')).body).toMatchObject({ automatizacionPausadaEn: null });
    expect(await prisma.auditLog.count({ where: { entidadId: chat, accion: { in: ['ATENCION_RESUELTA', 'AUTOMATIZACION_REANUDADA'] } } })).toBe(2);
  });

  it('cerrar el chat resuelve la solicitud; el barrido de inactividad no cierra una pendiente', async () => {
    const oferta = await ofrecerBotones();
    await webhook([toque(oferta.whatsappMsgId!)]);
    await prisma.$executeRaw`UPDATE "Mensaje" SET "createdAt" = now() - interval '90 days' WHERE "conversacionId" = ${chat}`;
    await prisma.$executeRaw`UPDATE "Conversacion" SET "createdAt" = now() - interval '90 days' WHERE id = ${chat}`;
    await app.get(CierreInactividadService).cerrarInactivas();
    expect((await conversacion()).cerradaEn).toBeNull();

    expect((await http(`/conversaciones/${chat}/cerrar`, 'POST')).status).toBe(201);
    const c = await conversacion();
    expect(c.atencionSolicitadaEn).toBeNull();
    expect(c.atencionTomadaPorId).toBeNull();
  });
});
