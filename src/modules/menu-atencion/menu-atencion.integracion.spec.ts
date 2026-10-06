import { PromocionesChatService } from '../conversaciones/promociones-chat.service';
import { CobrosService } from '../cobros/cobros.service';
import { PromocionesService } from '../promociones/promociones.service';
import { VentasService } from '../ventas/ventas.service';
import { LeadsService } from '../leads/leads.service';
import { AvisoLandingService } from '../../common/landing/aviso-landing.service';
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
import { ConversacionesService } from '../conversaciones/conversaciones.service';
import { EnvioPlantillasService } from '../conversaciones/envio-plantillas.service';
import { AtencionHumanaService } from '../conversaciones/atencion-humana.service';
import { ConversacionesController } from '../conversaciones/conversaciones.controller';
import { ConversacionesGateway } from '../conversaciones/conversaciones.gateway';
import { IngestaWhatsappService } from '../conversaciones/ingesta-whatsapp.service';
import { AcuseAutomaticoService } from '../conversaciones/acuse-automatico.service';
import { DespachadorSalienteService } from '../conversaciones/despachador-saliente.service';
import { MediaEntranteService } from '../conversaciones/media-entrante.service';
import { ReintentoSalienteService } from '../conversaciones/reintento-saliente.service';
import { CierreInactividadService } from '../conversaciones/cierre-inactividad.service';
import { WhatsappWebhookController } from '../conversaciones/webhooks/whatsapp-webhook.controller';
import { datosOferta, OfertaInteraccion } from '../conversaciones/interacciones-integracion';
import { FLOWS_PUBLICADOS } from '../conversaciones/flows-publicados';

/* El catálogo generado, con un Flow de cita publicado en una WABA sintética. Solo
   la línea que tenga esa WABA lo usa; las demás no tienen WABA en estas pruebas. */
jest.mock('../conversaciones/flows-publicados', () => ({
  FLOWS_PUBLICADOS: [{
    id: '900', wabaId: 'waba-sintetica-menu', version: 'solicitud-cita.v1', pantalla: 'MOTIVO', proposito: 'SOLICITUD_CITA',
    respuestas: { especialidad: ['GINECOLOGIA', 'MATERNIDAD'] }, etiquetas: { especialidad: 'Especialidad' },
    titulos: { especialidad: { GINECOLOGIA: 'Ginecología', MATERNIDAD: 'Maternidad' } },
  }],
}));
import { MenuAtencionController } from './menu-atencion.controller';
import { MenuAtencionService } from './menu-atencion.service';

/*
 * El menú de atención de punta a punta (docs/menu-atencion.md): se configura por
 * HTTP con los guards reales, llega con el webhook firmado, se guarda en
 * Postgres y sale por el despachador. Meta y el push son lo único simulado:
 * nada sale de esta máquina.
 */

// URL deliberadamente fija; nunca usar DATABASE_URL ni cargar .env en esta suite.
const prisma = new PrismaService('postgresql://crm_app@127.0.0.1:5433/crm_test');
const claveSintetica = Buffer.alloc(32, 11).toString('base64');
const secretoSintetico = 'firma-webhook-sintetica-menu';
const transporte = { enviar: jest.fn<Promise<ResultadoEnvio>, unknown[]>(), listarPlantillas: jest.fn() };
const push = { enviarAUsuario: jest.fn(async () => undefined) };
/* El acuse fuera de horario queda SIEMPRE fuera de horario: si el menú no lo
   reemplazara, cada prueba de la línea comercial lo vería salir. */
const config = new ConfigService({
  META_APP_SECRET: secretoSintetico,
  AUTORESPUESTA_TEXTO: 'Acuse sintético fuera de horario.',
  AUTORESPUESTA_HORARIO: 'D:03:00-03:01',
  UBICACION_AUTOMATICA: 'off',
});

@Module({
  imports: [JwtModule.register({ secret: 'jwt-sintetico-menu', signOptions: { expiresIn: '15m' } })],
  controllers: [ConversacionesController, WhatsappWebhookController, MenuAtencionController],
  providers: [
    { provide: PrismaService, useValue: prisma }, { provide: ConfigService, useValue: config },
    AuditService, AuthService, UsuariosService, ClientesService, CategoriaPacienteService, ServiciosService, TipoCambioService,
    LineasWhatsappService, PrimerContactoService, MemoriaAgenteService, ConversacionesService, EnvioPlantillasService, AtencionHumanaService,
    ConversacionesGateway, IngestaWhatsappService, MenuAtencionService, PromocionesChatService, CobrosService, PromocionesService, VentasService, LeadsService, AvisoLandingService, AcuseAutomaticoService, DespachadorSalienteService,
    ReintentoSalienteService, CierreInactividadService, MetaSignatureGuard,
    { provide: WhatsappCloudService, useValue: transporte },
    { provide: R2Service, useValue: { urlFirmada: async () => null } },
    { provide: PushService, useValue: push },
    { provide: AlertasWhatsappService, useValue: { procesar: async () => undefined } },
    { provide: MediaEntranteService, useValue: { despertar: () => undefined } },
    { provide: APP_GUARD, useClass: JwtAuthGuard }, { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
class ModuloMenuTest {}

const PREFIJO_TEL = '+591700028';
const telefono = `${PREFIJO_TEL}01`;
const otroTelefono = `${PREFIJO_TEL}02`;
const PHONE_RECEPCION = 'meta-menu-recepcion';
const PHONE_COMERCIAL = 'meta-menu-comercial';
const ORIENTACION = 'Orientación sintética de emergencia aprobada por la clínica.';
const envOriginal = { flag: process.env['WHATSAPP_INTERACCIONES'], key: process.env['WHATSAPP_INTERACCIONES_KEY'] };

let app: INestApplication;
let base: string;
let recepcion: string;
let comercial: string;
const usuarios: Record<'admin' | 'rec1' | 'rec2' | 'ventas', { id: string; token: string }> = {} as never;

const menuRecepcion = () => ({
  activo: true,
  saludo: 'Hola, ¿en qué te ayudamos?',
  opciones: [
    { tipo: 'PERSONA', titulo: 'Hablar con una persona', respuesta: 'Confirmación sintética: te escribe una persona.' },
    { tipo: 'EMERGENCIA', titulo: 'Es una emergencia', respuesta: ORIENTACION },
    { tipo: 'CITA', titulo: 'Solicitar una cita' },
    { tipo: 'RESPUESTA', titulo: 'Horarios', respuesta: 'Horario sintético de atención.' },
    { tipo: 'UBICACION', titulo: 'Cómo llegar' },
  ],
});
const menuVentas = () => ({
  activo: true,
  saludo: 'Hola, ¿qué te interesa?',
  opciones: [
    { tipo: 'PROMOCIONES', titulo: 'Ver promociones', respuesta: 'Promociones sintéticas vigentes:' },
    { tipo: 'PERSONA', titulo: 'Hablar con asesora' },
  ],
});

async function crearApp(): Promise<INestApplication> {
  const nueva = await NestFactory.create(ModuloMenuTest, { rawBody: true, logger: false, abortOnError: false });
  nueva.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await nueva.listen(0, '127.0.0.1');
  return nueva;
}
async function http(ruta: string, metodo = 'GET', bearer = usuarios.admin.token, cuerpo?: unknown) {
  const r = await fetch(base + ruta, {
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
function texto(cuerpo: string, de = telefono) {
  return { id: `wamid.in.${randomUUID()}`, from: de.slice(1), type: 'text', timestamp: ahoraMeta(), text: { body: cuerpo } };
}
/** Tocar una opción de una lista (o de botones) que le mandamos. */
function toque(contexto: string, opcion: string, tipo: 'list_reply' | 'button_reply' = 'list_reply', id = `wamid.in.${randomUUID()}`) {
  return { id, from: telefono.slice(1), type: 'interactive', timestamp: ahoraMeta(), context: { id: contexto }, interactive: { type: tipo, [tipo]: { id: opcion, title: 'Título que manda el teléfono' } } };
}
async function esperar(condicion: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 150; i++) { if (await condicion()) return; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('La condición no se cumplió a tiempo');
}
const reposo = () => new Promise(r => setTimeout(r, 300));
async function chatDe(lineaId: string, tel = telefono) {
  return prisma.conversacion.findFirstOrThrow({ where: { lineaId, cliente: { telefono: tel } } });
}
/** Las ofertas que el CRM le mandó solo (menú, lista de promociones), ya despachadas. */
async function ofertasEnviadas(conversacionId: string) {
  return prisma.mensaje.findMany({
    where: { conversacionId, direccion: 'SALIENTE', automatico: true, interaccion: { isNot: null }, whatsappMsgId: { not: null } },
    orderBy: { createdAt: 'asc' },
  });
}
async function textosAutomaticos(conversacionId: string) {
  return (await prisma.mensaje.findMany({ where: { conversacionId, automatico: true, interaccion: { is: null } }, orderBy: { createdAt: 'asc' } })).map(m => m.contenido);
}
/** La paciente escribe y le llega el menú; devuelve el chat y el wamid del menú. */
async function recibirMenu(lineaId = recepcion, phoneId = PHONE_RECEPCION) {
  expect((await webhook([texto('Hola')], phoneId)).status).toBe(200);
  const chat = await chatDe(lineaId);
  await esperar(async () => (await ofertasEnviadas(chat.id)).length === 1);
  return { chat: chat.id, menu: (await ofertasEnviadas(chat.id))[0].whatsappMsgId! };
}
async function guardarMenu(lineaId: string, menu: unknown) {
  const r = await http(`/menu-atencion/${lineaId}`, 'PUT', usuarios.admin.token, menu);
  expect(r.status).toBe(200);
  return r.body;
}

async function limpiar() {
  await prisma.cliente.deleteMany({ where: { telefono: { startsWith: PREFIJO_TEL } } });
  const ids = (await prisma.usuario.findMany({ where: { email: { endsWith: '@menu.test' } }, select: { id: true } })).map(u => u.id);
  await prisma.auditLog.deleteMany({ where: { OR: [{ usuarioId: { in: ids } }, { entidad: 'Conversacion', accion: { startsWith: 'ATENCION_' } }] } });
  await prisma.usuario.deleteMany({ where: { id: { in: ids } } });
  await prisma.lineaWhatsapp.deleteMany({ where: { nombre: { startsWith: 'MENU-' } } });
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
  delete process.env['WHATSAPP_INTERACCIONES_LINEAS'];
  await limpiar();
  transporte.enviar.mockReset().mockImplementation(async () => ({ estado: 'ENVIADO', metaMsgId: `wamid.out.${randomUUID()}` }));
  push.enviarAUsuario.mockClear();
  recepcion = (await prisma.lineaWhatsapp.create({ data: { nombre: 'MENU-recepcion', telefono: '+59170002891', phoneNumberId: PHONE_RECEPCION, tokenEnv: 'TOKEN_INEXISTENTE_MENU', comercial: false } })).id;
  comercial = (await prisma.lineaWhatsapp.create({ data: { nombre: 'MENU-comercial', telefono: '+59170002892', phoneNumberId: PHONE_COMERCIAL, tokenEnv: 'TOKEN_INEXISTENTE_MENU', comercial: true } })).id;
  const definiciones: [keyof typeof usuarios, Rol, string[]][] = [
    ['admin', 'SUPER_ADMIN', []], ['rec1', 'RECEPCION', [recepcion]], ['rec2', 'RECEPCION', [recepcion]], ['ventas', 'AGENTE', [comercial]],
  ];
  for (const [clave, rol, lineas] of definiciones) {
    const u = await prisma.usuario.create({ data: {
      nombre: `Persona ${clave}`, email: `${clave}@menu.test`, passwordHash: await bcrypt.hash('sintetico', 4), rol, activo: true,
      lineasWhatsapp: { create: lineas.map(lineaId => ({ lineaId })) },
    } });
    usuarios[clave] = { id: u.id, token: (await app.get(AuthService).login({ email: u.email, password: 'sintetico' })).access_token };
  }
  await guardarMenu(recepcion, menuRecepcion());
  await guardarMenu(comercial, menuVentas());
});

afterAll(async () => {
  delete process.env['WHATSAPP_INTERACCIONES_LINEAS'];
  await limpiar(); await app?.close(); await prisma.$disconnect();
  for (const [nombre, valor] of [['WHATSAPP_INTERACCIONES', envOriginal.flag], ['WHATSAPP_INTERACCIONES_KEY', envOriginal.key]] as const) {
    if (valor === undefined) delete process.env[nombre]; else process.env[nombre] = valor;
  }
});

describe('configurar el menú', () => {
  it('solo SUPER_ADMIN lo lee y lo guarda; queda constancia de quién lo cambió', async () => {
    expect((await http(`/menu-atencion/${recepcion}`, 'GET', usuarios.rec1.token)).status).toBe(403);
    expect((await http(`/menu-atencion/${recepcion}`, 'PUT', usuarios.rec1.token, menuRecepcion())).status).toBe(403);
    const leido = await http(`/menu-atencion/${recepcion}`);
    expect(leido.status).toBe(200);
    expect(leido.body).toMatchObject({ linea: { nombre: 'MENU-recepcion', comercial: false }, errores: [], actualizadoPor: { id: usuarios.admin.id }, enviosHabilitados: true });
    const opciones = (leido.body['menu'] as { opciones: { tipo: string; clave?: string }[] }).opciones;
    /* La respuesta informativa recibió su identidad estable del servidor. */
    expect(opciones.find(o => o.tipo === 'RESPUESTA')?.clave).toMatch(/^[a-z0-9]{8}$/);
    expect(await prisma.auditLog.count({ where: { entidad: 'MenuAtencion', entidadId: recepcion, accion: 'MENU_ACTUALIZADO', usuarioId: usuarios.admin.id } })).toBe(1);
  });

  it('rechaza un menú sin salida a una persona, o una opción de promociones sin su texto, con el motivo', async () => {
    const sinPersona = { ...menuRecepcion(), opciones: menuRecepcion().opciones.filter(o => o.tipo !== 'PERSONA') };
    const r = await http(`/menu-atencion/${recepcion}`, 'PUT', usuarios.admin.token, sinPersona);
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body['message'])).toContain('siempre ofrece hablar con una persona');
    const sinTexto = { ...menuVentas(), opciones: menuVentas().opciones.map(o => (o.tipo === 'PROMOCIONES' ? { tipo: o.tipo, titulo: o.titulo } : o)) };
    expect((await http(`/menu-atencion/${comercial}`, 'PUT', usuarios.admin.token, sinTexto)).status).toBe(400);
    expect((await http('/menu-atencion/no-existe', 'PUT', usuarios.admin.token, menuRecepcion())).status).toBe(404);
  });
});

describe('cuándo se ofrece', () => {
  it('al primer mensaje: una lista con las opciones, despachada a Meta; el segundo mensaje no la repite', async () => {
    const { chat } = await recibirMenu();
    const enviado = transporte.enviar.mock.calls.find(c => JSON.stringify(c[1]).includes('"type":"list"'));
    expect(JSON.stringify(enviado?.[1])).toContain('EMERGENCY');
    expect((await webhook([texto('¿Me escuchan?')])).status).toBe(200);
    await reposo();
    expect(await ofertasEnviadas(chat)).toHaveLength(1);
  });

  it('no se ofrece si una persona le escribió en las últimas 24 h', async () => {
    const paciente = await prisma.cliente.create({ data: { nombre: 'Paciente sintética', telefono } });
    const chat = await prisma.conversacion.create({ data: { clienteId: paciente.id, lineaId: recepcion } });
    await prisma.mensaje.create({ data: { conversacionId: chat.id, direccion: 'SALIENTE', contenido: 'Hola, soy de recepción', estadoEnvio: 'ENVIADO' } });
    expect((await webhook([texto('Gracias')])).status).toBe(200);
    await reposo();
    expect(await prisma.mensaje.count({ where: { conversacionId: chat.id, automatico: true } })).toBe(0);
  });

  it('apagado, o con la bandeja de interacciones apagada, la línea se comporta como antes', async () => {
    await guardarMenu(recepcion, { ...menuRecepcion(), activo: false });
    expect((await webhook([texto('Hola')])).status).toBe(200);
    await reposo();
    expect(await prisma.mensaje.count({ where: { conversacionId: (await chatDe(recepcion)).id, automatico: true } })).toBe(0);

    await guardarMenu(recepcion, menuRecepcion());
    process.env['WHATSAPP_INTERACCIONES'] = 'off';
    expect((await webhook([texto('Hola', otroTelefono)])).status).toBe(200);
    await reposo();
    expect(await prisma.mensaje.count({ where: { conversacionId: (await chatDe(recepcion, otroTelefono)).id, automatico: true } })).toBe(0);
  });

  it('en un piloto, solo las líneas de WHATSAPP_INTERACCIONES_LINEAS cambian; las demás siguen como con la bandera apagada', async () => {
    process.env['WHATSAPP_INTERACCIONES_LINEAS'] = ` ${comercial} `;
    expect((await http(`/menu-atencion/${recepcion}`)).body).toMatchObject({ enviosHabilitados: false });
    expect((await http(`/menu-atencion/${comercial}`)).body).toMatchObject({ enviosHabilitados: true });

    /* Recepción, fuera del piloto: ni menú ni «Atención», aunque escriba que es una emergencia. */
    expect((await webhook([texto('Hola')])).status).toBe(200);
    expect((await webhook([texto('es una emergencia')])).status).toBe(200);
    await reposo();
    const fuera = await chatDe(recepcion);
    expect(await prisma.mensaje.count({ where: { conversacionId: fuera.id, automatico: true } })).toBe(0);
    expect((await prisma.conversacion.findUniqueOrThrow({ where: { id: fuera.id } })).atencionSolicitadaEn).toBeNull();
    /* Y una persona de esa línea no puede mandar botones. */
    const botones = await http(`/conversaciones/${fuera.id}/mensajes`, 'POST', usuarios.rec1.token, {
      contenido: '', clientMessageId: randomUUID(), interaccion: { tipo: 'botones', cuerpo: '¿Confirmas?', opciones: [{ id: 'SI', titulo: 'Sí' }] },
    });
    expect(botones.status).toBe(400);

    /* La línea del piloto, con todo. */
    await recibirMenu(comercial, PHONE_COMERCIAL);
  });

  it('en la línea comercial el menú reemplaza al acuse fuera de horario: un solo automático', async () => {
    const { chat } = await recibirMenu(comercial, PHONE_COMERCIAL);
    await reposo();
    expect(await textosAutomaticos(chat)).not.toContain('Acuse sintético fuera de horario.');
  });

  it('si Meta rechaza el menú, sale el acuse de siempre: la paciente no se queda sin nada', async () => {
    transporte.enviar.mockImplementation(async (_tel: unknown, contenido: unknown) =>
      JSON.stringify(contenido).includes('"type":"interactive"')
        ? { estado: 'NO_SALIO', motivo: 'Rechazado por Meta (sintético)', codigoError: 131009 }
        : { estado: 'ENVIADO', metaMsgId: `wamid.out.${randomUUID()}` });
    expect((await webhook([texto('Hola')], PHONE_COMERCIAL)).status).toBe(200);
    const chat = await chatDe(comercial);
    await esperar(async () => (await textosAutomaticos(chat.id)).includes('Acuse sintético fuera de horario.'));
  });

  it('si el menú no sale (conversación en curso), el acuse fuera de horario sale como siempre', async () => {
    const paciente = await prisma.cliente.create({ data: { nombre: 'Paciente sintética', telefono } });
    const chat = await prisma.conversacion.create({ data: { clienteId: paciente.id, lineaId: comercial } });
    await prisma.mensaje.create({ data: { conversacionId: chat.id, direccion: 'SALIENTE', contenido: 'Hola, soy tu asesora', estadoEnvio: 'ENVIADO', createdAt: new Date(Date.now() - 3 * 3600_000) } });
    expect((await webhook([texto('¿Siguen ahí?')], PHONE_COMERCIAL)).status).toBe(200);
    await esperar(async () => (await textosAutomaticos(chat.id)).includes('Acuse sintético fuera de horario.'));
    expect(await ofertasEnviadas(chat.id)).toHaveLength(0);
  });
});

describe('qué hace cada opción', () => {
  it('«Hablar con una persona»: solicitud de prioridad alta, automatización callada y su confirmación sale igual', async () => {
    const { chat, menu } = await recibirMenu();
    expect((await webhook([toque(menu, 'TALK_TO_HUMAN')])).status).toBe(200);
    const c = await prisma.conversacion.findUniqueOrThrow({ where: { id: chat } });
    expect(c.atencionMotivo).toBe('SOLICITUD_EXPLICITA');
    expect(c.automatizacionPausadaEn).not.toBeNull();
    await esperar(async () => (await textosAutomaticos(chat)).includes('Confirmación sintética: te escribe una persona.'));
    /* Meta repite el webhook: no hay una segunda confirmación. */
    const repetido = toque(menu, 'TALK_TO_HUMAN');
    await webhook([repetido]); await webhook([repetido]);
    await reposo();
    expect((await textosAutomaticos(chat)).filter(t => t.startsWith('Confirmación sintética'))).toHaveLength(1);
  });

  it('«Es una emergencia»: prioridad crítica, primero en «Atención», orientación enviada y suena a todos', async () => {
    /* Otra paciente ya esperaba a una persona, desde antes. */
    expect((await webhook([texto('quiero hablar con una persona', otroTelefono)])).status).toBe(200);
    const otro = await chatDe(recepcion, otroTelefono);
    await prisma.silencioLinea.create({ data: { usuarioId: usuarios.rec2.id, lineaId: recepcion } });
    const { chat, menu } = await recibirMenu();
    push.enviarAUsuario.mockClear();

    expect((await webhook([toque(menu, 'EMERGENCY')])).status).toBe(200);
    const c = await prisma.conversacion.findUniqueOrThrow({ where: { id: chat } });
    expect(c.atencionMotivo).toBe('EMERGENCIA');
    const lista = await http('/conversaciones?tab=ATENCION', 'GET', usuarios.rec1.token);
    const datos = lista.body['datos'] as { id: string; atencion: { prioridad: string } }[];
    expect(datos.map(d => d.id)).toEqual([chat, otro.id]);
    expect(datos[0].atencion.prioridad).toBe('CRITICA');
    await esperar(async () => (await textosAutomaticos(chat)).includes(ORIENTACION));
    /* rec2 silenció la línea; una emergencia le suena igual. */
    await esperar(async () => push.enviarAUsuario.mock.calls.some(c => (c as unknown[])[0] === usuarios.rec2.id));
  });

  it('escribir «es una emergencia» hace lo mismo que el botón', async () => {
    const { chat } = await recibirMenu();
    expect((await webhook([texto('¡Es una emergencia!')])).status).toBe(200);
    expect((await prisma.conversacion.findUniqueOrThrow({ where: { id: chat } })).atencionMotivo).toBe('EMERGENCIA');
    await esperar(async () => (await textosAutomaticos(chat)).includes(ORIENTACION));
  });

  it('«Solicitar una cita»: solicitud pendiente de prioridad normal, nunca una reserva', async () => {
    const { chat, menu } = await recibirMenu();
    expect((await webhook([toque(menu, 'BOOK_APPOINTMENT')])).status).toBe(200);
    const detalle = await http(`/conversaciones/${chat}`, 'GET', usuarios.rec1.token);
    expect(detalle.body['atencion']).toMatchObject({ motivo: 'SOLICITUD_CITA', prioridad: 'NORMAL' });
  });

  it('«Solicitar una cita» con el Flow publicado en la WABA de la línea: lo abre, y lo que responde llega legible y una sola vez', async () => {
    const [flow] = FLOWS_PUBLICADOS;
    await prisma.lineaWhatsapp.update({ where: { id: recepcion }, data: { wabaId: flow.wabaId } });
    const { chat, menu } = await recibirMenu();
    expect((await webhook([toque(menu, 'BOOK_APPOINTMENT')])).status).toBe(200);
    await esperar(async () => (await ofertasEnviadas(chat)).length === 2);
    /* La solicitud nace con el toque, aunque no complete el Flow. */
    expect((await http(`/conversaciones/${chat}`, 'GET', usuarios.rec1.token)).body['atencion']).toMatchObject({ motivo: 'SOLICITUD_CITA' });
    const enviado = transporte.enviar.mock.calls.map(c => c[1] as { interactive?: { type: string; action: { parameters: { flow_id: string; flow_token: string } } } })
      .find(c => c.interactive?.type === 'flow');
    expect(enviado?.interactive?.action.parameters.flow_id).toBe('900');
    const ofertaFlow = (await ofertasEnviadas(chat))[1];

    const completar = () => ({
      id: `wamid.in.${randomUUID()}`, from: telefono.slice(1), type: 'interactive', timestamp: ahoraMeta(), context: { id: ofertaFlow.whatsappMsgId },
      interactive: { type: 'nfm_reply', nfm_reply: { name: 'flow', body: 'Sent', response_json: JSON.stringify({ flow_token: enviado!.interactive!.action.parameters.flow_token, flow_version: flow.version, especialidad: 'MATERNIDAD' }) } },
    });
    const primera = completar();
    expect((await webhook([primera])).status).toBe(200);
    const recibida = await prisma.mensaje.findUniqueOrThrow({ where: { whatsappMsgId: primera.id }, include: { interaccion: true } });
    expect(recibida.interaccion?.estado).toBe('CORRELACIONADA');
    expect(recibida.contenido).toContain('no hay ninguna cita reservada');
    expect((recibida.interaccion?.vista as Record<string, unknown>)['datos']).toEqual([{ etiqueta: 'Especialidad', valor: 'Maternidad' }]);
    /* Completarlo otra vez no crea otra solicitud ni otro Flow. */
    const segunda = completar();
    expect((await webhook([segunda])).status).toBe(200);
    expect((await prisma.mensaje.findUniqueOrThrow({ where: { whatsappMsgId: segunda.id }, include: { interaccion: true } })).interaccion?.estado).toBe('DUPLICADA');
    await reposo();
    expect(await ofertasEnviadas(chat)).toHaveLength(2);
  });

  it('«Solicitar una cita» sin Flow publicado en la WABA de la línea: la confirmación de siempre', async () => {
    const { chat, menu } = await recibirMenu();
    expect((await webhook([toque(menu, 'BOOK_APPOINTMENT')])).status).toBe(200);
    await reposo();
    expect(transporte.enviar.mock.calls.some(c => (c[1] as { interactive?: { type: string } }).interactive?.type === 'flow')).toBe(false);
    expect(await ofertasEnviadas(chat)).toHaveLength(1);
  });

  it('un TALK_TO_HUMAN de otra oferta (campaña, agente) pide persona pero no dispara la confirmación del menú', async () => {
    const { chat } = await recibirMenu();
    const clientMessageId = randomUUID();
    const oferta: OfertaInteraccion = { telefono, mensaje: { tipo: 'botones', cuerpo: 'Oferta de una agente', opciones: [{ id: 'TALK_TO_HUMAN', titulo: 'Hablar con alguien' }] } };
    const ajena = await prisma.mensaje.create({ data: {
      conversacionId: chat, direccion: 'SALIENTE', contenido: oferta.mensaje.cuerpo, clientMessageId,
      whatsappMsgId: `wamid.out.${randomUUID()}`, interaccion: { create: datosOferta(oferta, clientMessageId) },
    } });
    expect((await webhook([toque(ajena.whatsappMsgId!, 'TALK_TO_HUMAN', 'button_reply')])).status).toBe(200);
    expect((await prisma.conversacion.findUniqueOrThrow({ where: { id: chat } })).atencionMotivo).toBe('SOLICITUD_EXPLICITA');
    await reposo();
    expect(await textosAutomaticos(chat)).not.toContain('Confirmación sintética: te escribe una persona.');
  });

  it('pedir dos veces la misma información la responde dos veces', async () => {
    const { chat, menu } = await recibirMenu();
    const menuGuardado = (await http(`/menu-atencion/${recepcion}`)).body['menu'] as { opciones: { tipo: string; clave?: string }[] };
    const info = `INFO_${menuGuardado.opciones.find(o => o.tipo === 'RESPUESTA')!.clave}`;
    await webhook([toque(menu, info)]);
    await esperar(async () => (await textosAutomaticos(chat)).filter(t => t === 'Horario sintético de atención.').length === 1);
    await webhook([toque(menu, info)]);
    await esperar(async () => (await textosAutomaticos(chat)).filter(t => t === 'Horario sintético de atención.').length === 2);
  });

  it('una respuesta informativa se contesta sola, sin pedir a nadie; la ubicación manda el mapa', async () => {
    const { chat, menu } = await recibirMenu();
    const menuGuardado = (await http(`/menu-atencion/${recepcion}`)).body['menu'] as { opciones: { tipo: string; clave?: string }[] };
    const info = `INFO_${menuGuardado.opciones.find(o => o.tipo === 'RESPUESTA')!.clave}`;
    expect((await webhook([toque(menu, info)])).status).toBe(200);
    await esperar(async () => (await textosAutomaticos(chat)).includes('Horario sintético de atención.'));
    expect((await prisma.conversacion.findUniqueOrThrow({ where: { id: chat } })).atencionSolicitadaEn).toBeNull();

    transporte.enviar.mockClear();
    expect((await webhook([toque(menu, 'VIEW_LOCATION')])).status).toBe(200);
    await esperar(async () => transporte.enviar.mock.calls.some(c => JSON.stringify(c[1]).includes('"type":"location"')));
    expect((await prisma.conversacion.findUniqueOrThrow({ where: { id: chat } })).atencionSolicitadaEn).toBeNull();
  });

  it('el mismo menú sirve para varias opciones: primero «Horarios», después «Hablar con una persona»', async () => {
    const { chat, menu } = await recibirMenu();
    const menuGuardado = (await http(`/menu-atencion/${recepcion}`)).body['menu'] as { opciones: { tipo: string; clave?: string }[] };
    await webhook([toque(menu, `INFO_${menuGuardado.opciones.find(o => o.tipo === 'RESPUESTA')!.clave}`)]);
    await esperar(async () => (await textosAutomaticos(chat)).includes('Horario sintético de atención.'));
    expect((await webhook([toque(menu, 'TALK_TO_HUMAN')])).status).toBe(200);
    expect((await prisma.conversacion.findUniqueOrThrow({ where: { id: chat } })).atencionMotivo).toBe('SOLICITUD_EXPLICITA');
  });

  it('con una persona ya pedida, lo informativo que ella toca se contesta igual y su solicitud sigue como estaba', async () => {
    const { chat, menu } = await recibirMenu();
    await webhook([texto('quiero hablar con una persona')]);
    await esperar(async () => (await prisma.conversacion.findUniqueOrThrow({ where: { id: chat } })).atencionMotivo === 'SOLICITUD_EXPLICITA');
    const antes = await prisma.conversacion.findUniqueOrThrow({ where: { id: chat } });
    const menuGuardado = (await http(`/menu-atencion/${recepcion}`)).body['menu'] as { opciones: { tipo: string; clave?: string }[] };
    const info = `INFO_${menuGuardado.opciones.find(o => o.tipo === 'RESPUESTA')!.clave}`;
    expect((await webhook([toque(menu, info)])).status).toBe(200);
    await esperar(async () => (await textosAutomaticos(chat)).includes('Horario sintético de atención.'));
    /* «Cómo llegar» también: el pin sale aunque espere a una persona. */
    expect((await webhook([toque(menu, 'VIEW_LOCATION')])).status).toBe(200);
    await esperar(async () => (await textosAutomaticos(chat)).some(t => t.startsWith('📍')));
    const despues = await prisma.conversacion.findUniqueOrThrow({ where: { id: chat } });
    expect(despues).toMatchObject({ atencionMotivo: 'SOLICITUD_EXPLICITA', atencionSolicitadaEn: antes.atencionSolicitadaEn });
  });

  it('escribir «menú» lo muestra otra vez, aunque la conversación esté en curso', async () => {
    const { chat } = await recibirMenu();
    expect((await webhook([texto('Menú')])).status).toBe(200);
    await esperar(async () => (await ofertasEnviadas(chat)).length === 2);
    const [, segundo] = await ofertasEnviadas(chat);
    expect(segundo.contenido).toBe(menuRecepcion().saludo);
    /* Otra palabra cualquiera no lo repite. */
    expect((await webhook([texto('gracias')])).status).toBe(200);
    await reposo();
    expect(await ofertasEnviadas(chat)).toHaveLength(2);
  });

  it('si la clínica retiró la opción después de enviar el menú, no se contesta un texto viejo', async () => {
    const { chat, menu } = await recibirMenu();
    const anterior = (await http(`/menu-atencion/${recepcion}`)).body['menu'] as { opciones: { tipo: string; clave?: string }[] };
    const info = `INFO_${anterior.opciones.find(o => o.tipo === 'RESPUESTA')!.clave}`;
    await guardarMenu(recepcion, { ...menuRecepcion(), opciones: menuRecepcion().opciones.filter(o => o.tipo !== 'RESPUESTA') });
    expect((await webhook([toque(menu, info)])).status).toBe(200);
    await reposo();
    expect(await textosAutomaticos(chat)).not.toContain('Horario sintético de atención.');
    expect((await prisma.conversacion.findUniqueOrThrow({ where: { id: chat } })).atencionMotivo).toBe('REVISION');
  });

  it('sin promociones publicadas para WhatsApp en el CRM, la opción «Promociones» no aparece', async () => {
    /* La lista sale del módulo Promociones (una sola fuente con la landing). Con una
       publicada, elegir una manda su tarjeta: ver pagos-promocion.integracion.spec.ts. */
    await recibirMenu(comercial, PHONE_COMERCIAL);
    const menu = transporte.enviar.mock.calls.map(c => JSON.stringify(c[1])).find(e => e.includes('"type":"button"'))!;
    expect(menu).toContain('TALK_TO_HUMAN');
    expect(menu).not.toContain('VIEW_PROMOTIONS');
  });
});
