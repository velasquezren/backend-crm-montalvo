import { INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { createHmac, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
import { ConversacionesService } from './conversaciones.service';
import { EnvioPlantillasService } from './envio-plantillas.service';
import { ConversacionesController } from './conversaciones.controller';
import { ConversacionesGateway } from './conversaciones.gateway';
import { IngestaWhatsappService } from './ingesta-whatsapp.service';
import { AcuseAutomaticoService } from './acuse-automatico.service';
import { DespachadorSalienteService } from './despachador-saliente.service';
import { MediaEntranteService } from './media-entrante.service';
import { ReintentoSalienteService } from './reintento-saliente.service';
import { WhatsappWebhookController } from './webhooks/whatsapp-webhook.controller';
import { datosOferta, descifrarInteraccion, OfertaInteraccion, purgarInteracciones } from './interacciones-integracion';

// URL deliberadamente fija; nunca usar DATABASE_URL ni cargar .env en esta suite.
const prisma = new PrismaService('postgresql://crm_app@127.0.0.1:5433/crm_test');
const claveSintetica = Buffer.alloc(32, 7).toString('base64');
const secretoSintetico = 'firma-webhook-sintetica-fase2';
const transporte = { enviar: jest.fn<Promise<ResultadoEnvio>, unknown[]>(), listarPlantillas: jest.fn() };
const config = new ConfigService({ META_APP_SECRET: secretoSintetico, UBICACION_AUTOMATICA: 'off' });
@Module({
  imports: [JwtModule.register({ secret: 'jwt-sintetico-fase2', signOptions: { expiresIn: '15m' } })],
  controllers: [ConversacionesController, WhatsappWebhookController],
  providers: [
    { provide: PrismaService, useValue: prisma }, { provide: ConfigService, useValue: config },
    AuditService, AuthService, UsuariosService, ClientesService, CategoriaPacienteService, ServiciosService, TipoCambioService,
    LineasWhatsappService, PrimerContactoService, MemoriaAgenteService, ConversacionesService, EnvioPlantillasService,
    ConversacionesGateway, IngestaWhatsappService, AcuseAutomaticoService, DespachadorSalienteService,
    ReintentoSalienteService, MetaSignatureGuard,
    { provide: WhatsappCloudService, useValue: transporte },
    { provide: R2Service, useValue: { urlFirmada: async () => null } },
    { provide: PushService, useValue: { enviarAUsuario: async () => undefined } },
    { provide: AlertasWhatsappService, useValue: { procesar: async () => undefined } },
    { provide: MediaEntranteService, useValue: { despertar: () => undefined } },
    { provide: APP_GUARD, useClass: JwtAuthGuard }, { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
class ModuloInteraccionesTest {}

let app: INestApplication;
let base: string;
let linea: string;
let otraLinea: string;
let chat: string;
let otroChat: string;
let paciente: string;
let agente: string;
let otroAgente: string;
let token: string;
let otroToken: string;
let sinAccesoToken: string;
const telefono = '+59170002601';
const botones = { tipo: 'botones', cuerpo: 'Elige una opción de prueba', opciones: [{ id: 'TALK_TO_HUMAN', titulo: 'Recepción' }, { id: 'BOOK_APPOINTMENT', titulo: 'Solicitar cita' }] };
const envOriginal = { flag: process.env['WHATSAPP_INTERACCIONES'], key: process.env['WHATSAPP_INTERACCIONES_KEY'] };

async function http(ruta: string, metodo = 'GET', cuerpo?: unknown, bearer = token) {
  const respuesta = await fetch(base + ruta, { method: metodo, headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
  return { status: respuesta.status, body: await respuesta.json() as Record<string, unknown> };
}
async function webhook(mensajes: unknown[], phoneId = 'meta-test-2601', firma = true) {
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: phoneId }, messages: mensajes } }] }] });
  return fetch(base + '/webhooks/whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': firma ? `sha256=${createHmac('sha256', secretoSintetico).update(body).digest('hex')}` : 'sha256=00' }, body });
}
function respuesta(contexto: string, id = randomUUID(), opcion = 'TALK_TO_HUMAN') {
  return { id, from: telefono.slice(1), type: 'interactive', timestamp: String(Math.floor(Date.now() / 1000)), context: { id: contexto }, interactive: { type: 'button_reply', button_reply: { id: opcion, title: 'Título aportado por el cliente' } } };
}
async function esperar(condicion: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) { if (await condicion()) return; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('La operación local no terminó');
}
async function enviar(interaccion: unknown = botones, clientMessageId = randomUUID()) {
  const r = await http(`/conversaciones/${chat}/mensajes`, 'POST', { contenido: '', clientMessageId, interaccion });
  expect(r.status).toBe(201);
  const id = String(r.body['id']);
  await esperar(async () => (await prisma.mensaje.findUniqueOrThrow({ where: { id } })).estadoEnvio !== 'INCIERTO' && transporte.enviar.mock.calls.length > 0);
  return prisma.mensaje.findUniqueOrThrow({ where: { id } });
}
async function limpiar() {
  await prisma.cliente.deleteMany({ where: { telefono: { startsWith: '+591700026' } } });
  const ids = (await prisma.usuario.findMany({ where: { email: { endsWith: '@meta-phase2.test' } }, select: { id: true } })).map(u => u.id);
  await prisma.auditLog.deleteMany({ where: { usuarioId: { in: ids } } });
  await prisma.usuario.deleteMany({ where: { id: { in: ids } } });
  await prisma.lineaWhatsapp.deleteMany({ where: { nombre: { startsWith: 'META-FASE2-' } } });
}
beforeAll(async () => {
  process.env['WHATSAPP_INTERACCIONES'] = 'on';
  process.env['WHATSAPP_INTERACCIONES_KEY'] = claveSintetica;
  app = await NestFactory.create(ModuloInteraccionesTest, { rawBody: true, logger: false, abortOnError: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0, '127.0.0.1'); base = await app.getUrl();
}, 30_000);
beforeEach(async () => {
  process.env['WHATSAPP_INTERACCIONES'] = 'on';
  process.env['WHATSAPP_INTERACCIONES_KEY'] = claveSintetica;
  await limpiar();
  transporte.enviar.mockReset().mockImplementation(async () => ({ estado: 'ENVIADO', metaMsgId: `wamid.test.${randomUUID()}` }));
  linea = (await prisma.lineaWhatsapp.create({ data: { nombre: 'META-FASE2-recepcion', telefono: '+59170002691', phoneNumberId: 'meta-test-2601', tokenEnv: 'TOKEN_INEXISTENTE_META_PHASE2', comercial: false } })).id;
  otraLinea = (await prisma.lineaWhatsapp.create({ data: { nombre: 'META-FASE2-comercial', telefono: '+59170002692', phoneNumberId: 'meta-test-2602', tokenEnv: 'TOKEN_INEXISTENTE_META_PHASE2', comercial: true } })).id;
  const usuarios = await Promise.all(['agente', 'otro', 'sinAcceso'].map(async nombre => prisma.usuario.create({ data: { nombre, email: `${nombre}@meta-phase2.test`, passwordHash: await bcrypt.hash('sintetico', 4), rol: 'RECEPCION', activo: true, lineasWhatsapp: { create: nombre === 'sinAcceso' ? [] : [{ lineaId: linea }] } } })));
  agente = usuarios[0].id; otroAgente = usuarios[1].id;
  [token, otroToken, sinAccesoToken] = await Promise.all(usuarios.map(async u => (await app.get(AuthService).login({ email: u.email, password: 'sintetico' })).access_token));
  paciente = (await prisma.cliente.create({ data: { nombre: 'Persona sintética', telefono } })).id;
  chat = (await prisma.conversacion.create({ data: { clienteId: paciente, lineaId: linea } })).id;
  otroChat = (await prisma.conversacion.create({ data: { clienteId: paciente, lineaId: otraLinea } })).id;
  await prisma.mensaje.create({ data: { conversacionId: chat, direccion: 'ENTRANTE', contenido: 'Hola' } });
});
afterAll(async () => {
  await limpiar(); await app?.close(); await prisma.$disconnect();
  for (const [nombre, valor] of [['WHATSAPP_INTERACCIONES', envOriginal.flag], ['WHATSAPP_INTERACCIONES_KEY', envOriginal.key]]) {
    if (valor === undefined) delete process.env[nombre!]; else process.env[nombre!] = valor;
  }
});

it('botón firmado → persistencia, correlación, historial seguro y deduplicación', async () => {
  const saliente = await enviar(); const raw = respuesta(saliente.whatsappMsgId!);
  expect((await webhook([raw])).status).toBe(200);
  expect((await webhook([raw])).status).toBe(200);
  const m = await prisma.mensaje.findUniqueOrThrow({ where: { whatsappMsgId: raw.id }, include: { interaccion: true } });
  expect(m.contenido).toBe('Recepción'); expect(m.interaccion?.estado).toBe('CORRELACIONADA');
  expect(descifrarInteraccion(m.interaccion!.privado!, m.id)).toEqual(raw);
  expect(transporte.enviar).toHaveBeenCalledTimes(1);
  const historial = await http(`/conversaciones/${chat}`);
  expect(JSON.stringify(historial.body)).toContain('CORRELACIONADA');
  expect(JSON.stringify(historial.body)).not.toMatch(/privado|consumidaPor|flow_token|Título aportado/);
  const anteriores = await app.get(ConversacionesService).obtenerMensajesAnteriores(chat, new Date(Date.now() + 1000).toISOString(), 50, agente);
  expect(JSON.stringify(anteriores)).toContain('CORRELACIONADA');
});
it('dos respuestas simultáneas consumen una sola oferta; el mismo wamid se persiste una vez', async () => {
  const m = await enviar(); const a = respuesta(m.whatsappMsgId!); const b = respuesta(m.whatsappMsgId!);
  expect((await Promise.all([webhook([a]), webhook([b]), webhook([a])])).map(r => r.status)).toEqual([200, 200, 200]);
  const filas = await prisma.interaccionMensaje.findMany({ where: { mensaje: { whatsappMsgId: { in: [a.id, b.id] } } } });
  expect(filas.map(f => f.estado).sort()).toEqual(['CORRELACIONADA', 'DUPLICADA']);
});
it('falla el cifrado: rollback del mensaje y de la reapertura; reintento del webhook recupera', async () => {
  await prisma.conversacion.update({ where: { id: chat }, data: { cerradaEn: new Date() } });
  const raw = respuesta('sin-origen'); delete process.env['WHATSAPP_INTERACCIONES_KEY'];
  expect((await webhook([raw])).status).toBe(503);
  expect(await prisma.mensaje.count({ where: { whatsappMsgId: raw.id } })).toBe(0);
  expect((await prisma.conversacion.findUniqueOrThrow({ where: { id: chat } })).cerradaEn).not.toBeNull();
  process.env['WHATSAPP_INTERACCIONES_KEY'] = claveSintetica;
  expect((await webhook([raw])).status).toBe(200);
  expect((await prisma.conversacion.findUniqueOrThrow({ where: { id: chat } })).cerradaEn).toBeNull();
});
it('rechaza firma inválida sin persistir', async () => {
  const raw = respuesta('sin-origen'); expect((await webhook([raw], undefined, false)).status).toBe(403);
  expect(await prisma.mensaje.count({ where: { whatsappMsgId: raw.id } })).toBe(0);
});
it('lista: usa ID ofrecido y conserva la estructura', async () => {
  const m = await enviar({ tipo: 'lista', cuerpo: 'Elige', boton: 'Ver opciones', secciones: [{ titulo: 'Atención', opciones: [{ id: 'VIEW_HOURS', titulo: 'Horarios' }] }] });
  const raw = { ...respuesta(m.whatsappMsgId!), interactive: { type: 'list_reply', list_reply: { id: 'VIEW_HOURS', title: 'Otro título' } } };
  expect((await webhook([raw])).status).toBe(200);
  expect((await prisma.mensaje.findUniqueOrThrow({ where: { whatsappMsgId: raw.id }, include: { interaccion: true } })).interaccion?.estado).toBe('CORRELACIONADA');
});
it('quick reply de plantilla aprobada correlaciona por payload estable', async () => {
  jest.spyOn(app.get(EnvioPlantillasService), 'listarPlantillas').mockResolvedValueOnce([{ nombre: 'atencion_test', idioma: 'es', categoria: 'UTILITY', cuerpo: 'Ayuda', nombresVariables: [], variables: 0, formato: 'POSITIONAL', pie: null, botones: ['Recepción'], respuestasRapidas: [{ indice: 0, titulo: 'Recepción' }], imagenCabecera: null, enviable: true, motivoNoEnviable: null }]);
  const r = await app.get(EnvioPlantillasService).enviarPlantilla(chat, { plantilla: 'atencion_test', idioma: 'es', clientMessageId: randomUUID() }, agente, agente);
  await esperar(async () => !!(await prisma.mensaje.findUniqueOrThrow({ where: { id: r.id } })).whatsappMsgId);
  const m = await prisma.mensaje.findUniqueOrThrow({ where: { id: r.id }, include: { interaccion: true } });
  const oferta = descifrarInteraccion(m.interaccion!.privado!, m.clientMessageId!) as OfertaInteraccion;
  const raw = { ...respuesta(m.whatsappMsgId!), type: 'button', interactive: undefined, button: { payload: oferta.respuestasPlantilla![0].id, text: 'Recepción' } };
  expect((await webhook([raw])).status).toBe(200);
  expect((await prisma.mensaje.findUniqueOrThrow({ where: { whatsappMsgId: raw.id }, include: { interaccion: true } })).interaccion?.estado).toBe('CORRELACIONADA');
});
it.each(['token', 'version', 'correcta'])('Flow: validación de %s contra oferta y versión persistidas', async variante => {
  const clientMessageId = randomUUID();
  const oferta: OfertaInteraccion = { telefono, mensaje: { tipo: 'flow', cuerpo: 'Solicitud', flowId: '100', correlacion: 'token-sintetico', cta: 'Solicitar', modo: 'published', inicio: { accion: 'navigate', pantalla: 'SOLICITUD' } }, flow: { id: '100', version: 'v1', pantalla: 'SOLICITUD', respuestas: { resultado: ['SOLICITUD_DE_CITA'] } } };
  const m = await prisma.mensaje.create({ data: { conversacionId: chat, direccion: 'SALIENTE', contenido: 'Solicitud', clientMessageId, whatsappMsgId: randomUUID(), interaccion: { create: datosOferta(oferta, clientMessageId) } } });
  const raw = { ...respuesta(m.whatsappMsgId!), interactive: { type: 'nfm_reply', nfm_reply: { name: 'flow', response_json: JSON.stringify({ flow_token: variante === 'token' ? 'incorrecto' : 'token-sintetico', flow_version: variante === 'version' ? 'v2' : 'v1', resultado: 'SOLICITUD_DE_CITA' }) } } };
  expect((await webhook([raw])).status).toBe(200);
  const entrada = await prisma.mensaje.findUniqueOrThrow({ where: { whatsappMsgId: raw.id }, include: { interaccion: true } });
  expect(entrada.interaccion?.estado).toBe(variante === 'correcta' ? 'CORRELACIONADA' : 'NO_CORRELACIONADA');
  expect(JSON.stringify((await http(`/conversaciones/${chat}`)).body)).not.toContain('token-sintetico');
});
it.each(['caducada', 'opcion', 'linea', 'paciente', 'contexto'])('no autoriza respuestas con %s incorrecta', async variante => {
  const m = await enviar();
  if (variante === 'caducada') await prisma.interaccionMensaje.update({ where: { mensajeId: m.id }, data: { venceEn: new Date(0) } });
  const raw = respuesta(variante === 'contexto' ? 'ajeno' : m.whatsappMsgId!, randomUUID(), variante === 'opcion' ? 'INVENTADA' : 'TALK_TO_HUMAN');
  if (variante === 'paciente') raw.from = '59170002602';
  expect((await webhook([raw], variante === 'linea' ? 'meta-test-2602' : undefined)).status).toBe(200);
  const fila = await prisma.mensaje.findUniqueOrThrow({ where: { whatsappMsgId: raw.id }, include: { interaccion: true } });
  expect(fila.interaccion?.estado).toBe(variante === 'caducada' ? 'CADUCADA' : 'NO_CORRELACIONADA');
});
it('tipo desconocido y Flow inválido conservan todos los campos privados tras whitelist', async () => {
  const unknown = { id: randomUUID(), from: telefono.slice(1), type: 'nuevo_tipo', nuevo_tipo: { secretoSintetico: 'conservar-cifrado' } };
  const invalido = { ...respuesta('sin-origen'), interactive: { type: 'nfm_reply', nfm_reply: { name: 'flow', response_json: 'no-json' } } };
  expect((await webhook([unknown, invalido])).status).toBe(200);
  const m = await prisma.mensaje.findUniqueOrThrow({ where: { whatsappMsgId: unknown.id }, include: { interaccion: true } });
  expect(descifrarInteraccion(m.interaccion!.privado!, m.id)).toEqual(unknown);
  expect(m.interaccion?.estado).toBe('DESCONOCIDA');
  expect((await prisma.mensaje.findUniqueOrThrow({ where: { whatsappMsgId: invalido.id }, include: { interaccion: true } })).interaccion?.estado).toBe('INVALIDA');
});
it('el despachador abre un Flow desde snapshot; HTTP rechaza IDs no autorizados', async () => {
  const key = randomUUID();
  const oferta: OfertaInteraccion = { telefono, mensaje: { tipo: 'flow', cuerpo: 'Solicitud sintética', flowId: '100', correlacion: 'token-sintetico', cta: 'Solicitar', modo: 'published', inicio: { accion: 'navigate', pantalla: 'SOLICITUD' } }, flow: { id: '100', version: 'v1', pantalla: 'SOLICITUD', respuestas: {} } };
  expect((await http(`/conversaciones/${chat}/mensajes`, 'POST', { contenido: '', clientMessageId: key, interaccion: oferta.mensaje })).status).toBe(400);
  const m = await prisma.mensaje.create({ data: { conversacionId: chat, direccion: 'SALIENTE', contenido: 'Solicitud sintética', clientMessageId: key, estadoEnvio: 'FALLIDO', interaccion: { create: datosOferta(oferta, key) } } });
  await app.get(DespachadorSalienteService).interaccion({ mensajeId: m.id, conversacionId: chat, telefono });
  expect(transporte.enviar.mock.calls[0][1]).toMatchObject({ type: 'interactive', interactive: { type: 'flow', action: { parameters: { flow_id: '100', flow_token: 'token-sintetico', flow_message_version: '3', flow_action_payload: { screen: 'SOLICITUD' } } } } });
});
it('mismo clientMessageId concurrente produce un envío; intención cambiada responde 409', async () => {
  const key = randomUUID(); const body = { contenido: '', interaccion: botones, clientMessageId: key };
  const replies = await Promise.all([http(`/conversaciones/${chat}/mensajes`, 'POST', body), http(`/conversaciones/${chat}/mensajes`, 'POST', body)]);
  expect(replies.map(r => r.status)).toEqual([201, 201]); expect(replies[0].body['id']).toBe(replies[1].body['id']);
  await esperar(async () => transporte.enviar.mock.calls.length === 1);
  expect((await http(`/conversaciones/${chat}/mensajes`, 'POST', { ...body, interaccion: { ...botones, cuerpo: 'Otra intención' } })).status).toBe(409);
});
it('NO_SALIO recupera la misma estructura; INCIERTO no se reenvía', async () => {
  transporte.enviar.mockResolvedValueOnce({ estado: 'NO_SALIO', motivo: 'Fallo sintético previo a envío' });
  const m = await enviar(); const primero = transporte.enviar.mock.calls[0][1];
  await prisma.mensaje.update({ where: { id: m.id }, data: { proximoIntento: new Date(0) } });
  await app.get(ReintentoSalienteService).barrerEnviosPendientes();
  expect(transporte.enviar.mock.calls[1][1]).toEqual(primero);
  await prisma.mensaje.update({ where: { id: m.id }, data: { estadoEnvio: 'FALLIDO', proximoIntento: new Date(0) } });
  transporte.enviar.mockResolvedValueOnce({ estado: 'INCIERTO', motivo: 'Timeout sintético' });
  await app.get(ReintentoSalienteService).barrerEnviosPendientes();
  await app.get(ReintentoSalienteService).barrerEnviosPendientes();
  expect(transporte.enviar).toHaveBeenCalledTimes(3);
  expect((await prisma.mensaje.findUniqueOrThrow({ where: { id: m.id } })).estadoEnvio).toBe('INCIERTO');
});
it('reinicio de proceso reconstruye lo pendiente; una llamada interrumpida queda incierta', async () => {
  const clientMessageId = randomUUID();
  const m = await prisma.mensaje.create({ data: { conversacionId: chat, direccion: 'SALIENTE', contenido: botones.cuerpo, clientMessageId, estadoEnvio: 'FALLIDO', proximoIntento: new Date(0), interaccion: { create: datosOferta({ mensaje: botones as OfertaInteraccion['mensaje'], telefono }, clientMessageId) } } });
  const ejecutar = async (modo: string) => promisify(execFile)(process.execPath, ['scripts/test-interacciones-reinicio.cjs', m.id, modo], { timeout: 10_000, env: { PATH: process.env['PATH'], NODE_ENV: 'test', WHATSAPP_INTERACCIONES: 'on', WHATSAPP_INTERACCIONES_KEY: claveSintetica } });
  const primero = await ejecutar('interrumpir'); expect(primero.stdout).toContain('INTERRUMPIDO');
  expect((await prisma.mensaje.findUniqueOrThrow({ where: { id: m.id } })).estadoEnvio).toBe('INCIERTO');
  expect((await ejecutar('normal')).stdout).toContain('ENVIOS:0');
  // Fallo definitivo confirmado: el nuevo proceso sí puede reconstruir la intención persistida.
  await prisma.mensaje.update({ where: { id: m.id }, data: { estadoEnvio: 'FALLIDO' } });
  expect((await ejecutar('normal')).stdout).toContain('ENVIOS:1');
  expect((await prisma.mensaje.findUniqueOrThrow({ where: { id: m.id } })).estadoEnvio).toBe('ENVIADO');
}, 30_000);
it('un status tardío del intento anterior no resuelve el nuevo envío incierto', async () => {
  const m = await enviar(); const service = app.get(ConversacionesService);
  await service.procesarEstadoMensaje(m.whatsappMsgId!, 'failed', m.id, linea);
  await prisma.mensaje.update({ where: { id: m.id }, data: { proximoIntento: new Date(0) } });
  transporte.enviar.mockResolvedValueOnce({ estado: 'INCIERTO', motivo: 'Timeout del segundo intento' });
  await app.get(ReintentoSalienteService).barrerEnviosPendientes();
  await service.procesarEstadoMensaje(m.whatsappMsgId!, 'sent', m.id, linea);
  const pendiente = await prisma.mensaje.findUniqueOrThrow({ where: { id: m.id } });
  expect(pendiente.estadoEnvio).toBe('INCIERTO'); expect(pendiente.whatsappMsgId).toBeNull();
  const nuevoId = `wamid.test.${randomUUID()}`;
  await service.procesarEstadoMensaje(nuevoId, 'delivered', m.id, linea);
  const resuelto = await prisma.mensaje.findUniqueOrThrow({ where: { id: m.id } });
  expect(resuelto.estadoEnvio).toBe('ENTREGADO'); expect(resuelto.whatsappMsgId).toBe(nuevoId);
  expect(transporte.enviar).toHaveBeenCalledTimes(2);
});
it('permisos HTTP: recepción compartida sí; sin línea y línea comercial ajena no', async () => {
  expect((await http(`/conversaciones/${chat}`, 'GET', undefined, '')).status).toBe(401);
  expect((await http(`/conversaciones/${chat}`, 'GET', undefined, sinAccesoToken)).status).toBe(404);
  expect((await http(`/conversaciones/${chat}`, 'GET', undefined, otroToken)).status).toBe(200);
  expect((await http(`/conversaciones/${otroChat}`, 'GET')).status).toBe(404);
  const body = { contenido: '', interaccion: botones, clientMessageId: randomUUID() };
  expect((await http(`/conversaciones/${chat}/mensajes`, 'POST', body, sinAccesoToken)).status).toBe(404);
  expect(transporte.enviar).not.toHaveBeenCalled();
});
it('toma de control y conversación cerrada conservan asignación y no disparan respuestas automáticas', async () => {
  await prisma.conversacion.update({ where: { id: chat }, data: { agenteId: otroAgente, cerradaEn: new Date() } });
  expect((await webhook([respuesta('legacy-no-correlacionado')])).status).toBe(200);
  const c = await prisma.conversacion.findUniqueOrThrow({ where: { id: chat } });
  expect(c.agenteId).toBe(otroAgente); expect(c.cerradaEn).toBeNull(); expect(c.esperandoRespuesta).toBe(true);
  expect(transporte.enviar).not.toHaveBeenCalled();
});
it('línea comercial asignada: tener acceso a la línea no permite leer el chat de otra agente', async () => {
  await prisma.usuario.updateMany({ where: { id: { in: [agente, otroAgente] } }, data: { rol: 'AGENTE' } });
  await prisma.accesoLineaWhatsapp.createMany({ data: [{ usuarioId: agente, lineaId: otraLinea }, { usuarioId: otroAgente, lineaId: otraLinea }] });
  await prisma.conversacion.update({ where: { id: otroChat }, data: { agenteId: agente } });
  const propio = (await app.get(AuthService).login({ email: 'agente@meta-phase2.test', password: 'sintetico' })).access_token;
  const ajeno = (await app.get(AuthService).login({ email: 'otro@meta-phase2.test', password: 'sintetico' })).access_token;
  expect((await http(`/conversaciones/${otroChat}`, 'GET', undefined, propio)).status).toBe(200);
  expect((await http(`/conversaciones/${otroChat}`, 'GET', undefined, ajeno)).status).toBe(404);
  expect((await http(`/conversaciones/${otroChat}/mensajes`, 'POST', { contenido: '', clientMessageId: randomUUID(), interaccion: botones }, ajeno)).status).toBe(404);
});
it('apagar la función no convierte un interactivo pendiente en texto ni lo reenvía', async () => {
  const m = await enviar();
  await prisma.mensaje.update({ where: { id: m.id }, data: { estadoEnvio: 'FALLIDO', proximoIntento: new Date(0) } });
  process.env['WHATSAPP_INTERACCIONES'] = 'off';
  await app.get(ReintentoSalienteService).barrerEnviosPendientes();
  expect(transporte.enviar).toHaveBeenCalledTimes(1);
});
it('estados de Meta mantienen aislamiento de línea y no retroceden de leído', async () => {
  const m = await enviar(); const service = app.get(ConversacionesService);
  await service.procesarEstadoMensaje(m.whatsappMsgId!, 'read', m.id, otraLinea);
  expect((await prisma.mensaje.findUniqueOrThrow({ where: { id: m.id } })).estadoEnvio).toBe('ENVIADO');
  await service.procesarEstadoMensaje(m.whatsappMsgId!, 'read', m.id, linea);
  await service.procesarEstadoMensaje(m.whatsappMsgId!, 'failed', m.id, linea, 131047);
  expect((await prisma.mensaje.findUniqueOrThrow({ where: { id: m.id } })).estadoEnvio).toBe('LEIDO');
});
it('ventana cerrada, límites Meta y feature desactivada rechazan antes de guardar', async () => {
  const ruta = `/conversaciones/${chat}/mensajes`;
  const body = { contenido: '', interaccion: botones, clientMessageId: randomUUID() };
  expect((await http(ruta, 'POST', { ...body, interaccion: { ...botones, opciones: [...botones.opciones, ...botones.opciones] } })).status).toBe(400);
  process.env['WHATSAPP_INTERACCIONES'] = 'off'; expect((await http(ruta, 'POST', body)).status).toBe(400);
  process.env['WHATSAPP_INTERACCIONES'] = 'on';
  await prisma.mensaje.updateMany({ where: { conversacionId: chat }, data: { createdAt: new Date(0) } });
  expect((await http(ruta, 'POST', body)).status).toBe(400); expect(transporte.enviar).not.toHaveBeenCalled();
});
it('retención elimina el original cifrado y no permite degradar una oferta a texto', async () => {
  const m = await enviar(); await prisma.interaccionMensaje.update({ where: { mensajeId: m.id }, data: { purgarEn: new Date(0) } });
  await purgarInteracciones(prisma);
  expect((await prisma.interaccionMensaje.findUniqueOrThrow({ where: { mensajeId: m.id } })).privado).toBeNull();
  await prisma.mensaje.update({ where: { id: m.id }, data: { estadoEnvio: 'FALLIDO', proximoIntento: new Date(0) } });
  await app.get(ReintentoSalienteService).barrerEnviosPendientes(); expect(transporte.enviar).toHaveBeenCalledTimes(1);
});
it('error parcial del lote: lo correcto persiste, el reintento no duplica', async () => {
  const raw = respuesta('sin-origen');
  const ingesta = app.get(IngestaWhatsappService);
  const original = ingesta.procesarEntrante.bind(ingesta);
  const spy = jest.spyOn(ingesta, 'procesarEntrante').mockRejectedValueOnce(new Error('Fallo sintético')).mockImplementation(original);
  const segundo = respuesta('sin-origen');
  expect((await webhook([raw, segundo])).status).toBe(503);
  expect(await prisma.mensaje.count({ where: { whatsappMsgId: { in: [raw.id, segundo.id] } } })).toBe(1);
  spy.mockRestore(); expect((await webhook([raw, segundo])).status).toBe(200);
  expect(await prisma.mensaje.count({ where: { whatsappMsgId: { in: [raw.id, segundo.id] } } })).toBe(2);
});
it('Socket.IO real avisa al personal autorizado y permite recargar el historial seguro', async () => {
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/socket.io/?EIO=4&transport=websocket');
  const eventos: string[] = [];
  let conectado = false;
  ws.addEventListener('message', event => {
    const data = String(event.data);
    if (data.startsWith('0')) ws.send(`40/realtime,${JSON.stringify({ token })}`);
    if (data.startsWith('40/realtime,')) conectado = true;
    if (data === '2') ws.send('3');
    if (data.startsWith('42/realtime,')) eventos.push(data);
  });
  try {
    await esperar(async () => conectado);
    expect((await webhook([respuesta('sin-origen')])).status).toBe(200);
    await esperar(async () => eventos.some(e => e.includes(chat)));
    expect(eventos.join('')).toContain('conversacion:actividad');
    expect(eventos.join('')).not.toMatch(/privado|flow_token|response_json/);
    expect(JSON.stringify((await http(`/conversaciones/${chat}`)).body)).toContain('NO_CORRELACIONADA');
  } finally { ws.close(); }
});
