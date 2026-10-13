import { PromocionesChatService } from './promociones-chat.service';
import { CobrosService } from '../cobros/cobros.service';
import { PromocionesService } from '../promociones/promociones.service';
import { VentasService } from '../ventas/ventas.service';
import { LeadsService } from '../leads/leads.service';
import { AvisoLandingService } from '../../common/landing/aviso-landing.service';
import { MenuAtencionService } from '../menu-atencion/menu-atencion.service';
import { INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { createHmac, randomUUID } from 'node:crypto';
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
import { AtencionHumanaService } from './atencion-humana.service';
import { ConversacionesController } from './conversaciones.controller';
import { ConversacionesGateway } from './conversaciones.gateway';
import { IngestaWhatsappService } from './ingesta-whatsapp.service';
import { AcuseAutomaticoService } from './acuse-automatico.service';
import { DespachadorSalienteService } from './despachador-saliente.service';
import { MediaEntranteService } from './media-entrante.service';
import { WhatsappWebhookController } from './webhooks/whatsapp-webhook.controller';
import { OfertaInteraccion } from './interacciones-integracion';

import { InformesChatService } from '../resultados/informes-chat.service';
import { PortalResultadosClient } from '../resultados/portal-resultados.client';

// URL deliberadamente fija, como el resto de las suites: nunca DATABASE_URL ni un .env,
// y sin variable propia que la CI tendría que conocer (con ella, la suite no corría en CI).
const prisma = new PrismaService('postgresql://crm_app@127.0.0.1:5433/crm_test');
const secretoSintetico = 'firma-sintetica-informes';
const config = new ConfigService({ META_APP_SECRET: secretoSintetico, UBICACION_AUTOMATICA: 'off', TOKEN_INEXISTENTE_INFORMES: 'sintetico' });
const transporte = { enviar: jest.fn<Promise<ResultadoEnvio>, unknown[]>(), subirPdf: jest.fn(), listarPlantillas: jest.fn() };
const portal = { informesDelPaciente: jest.fn(), pdfDelPaciente: jest.fn() };
const telefono = '+59170005901';
const informe = { id: 'c03202ee-09cb-41d4-a4c8-9c39640bc33f', archivoId: 'c03202ee-09cb-41d4-a4c8-9c39640bc3340', estudio: 'Estudio sintético', fechaEstudio: '2026-10-01T00:00:00.000Z' };
@Module({
  imports: [JwtModule.register({ secret: 'jwt-sintetico-atencion', signOptions: { expiresIn: '15m' } })],
  controllers: [ConversacionesController, WhatsappWebhookController],
  providers: [
    { provide: PrismaService, useValue: prisma }, { provide: ConfigService, useValue: config },
    AuditService, AuthService, UsuariosService, ClientesService, CategoriaPacienteService, ServiciosService, TipoCambioService,
    LineasWhatsappService, PrimerContactoService, MemoriaAgenteService, ConversacionesService, EnvioPlantillasService, AtencionHumanaService,
    ConversacionesGateway, IngestaWhatsappService, MenuAtencionService, PromocionesChatService, CobrosService, PromocionesService, VentasService, LeadsService, AvisoLandingService, AcuseAutomaticoService, DespachadorSalienteService,
    MetaSignatureGuard, InformesChatService,
    { provide: PortalResultadosClient, useValue: portal },
    { provide: WhatsappCloudService, useValue: transporte },
    { provide: R2Service, useValue: { urlFirmada: async () => null } },
    { provide: PushService, useValue: { enviarAUsuario: async () => undefined } },
    { provide: AlertasWhatsappService, useValue: { procesar: async () => undefined } },
    { provide: MediaEntranteService, useValue: { despertar: () => undefined } },
    { provide: APP_GUARD, useClass: JwtAuthGuard }, { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
class ModuloInformesTest {}


let app: INestApplication;
let base: string;
let linea: string;
let chat: string;
let paciente: string;
let ingesta: IngestaWhatsappService;
async function limpiar() {
  await prisma.cliente.deleteMany({ where: { telefono } });
  await prisma.lineaWhatsapp.deleteMany({ where: { nombre: 'INFORMES-TEST' } });
}
async function esperar(f: () => Promise<boolean>) {
  for (let n = 0; n < 200; n++) { if (await f()) return; await new Promise(r => setTimeout(r, 15)); }
  throw new Error('No terminó la operación');
}
async function oferta() {
  expect(await app.get(InformesChatService).oferta(chat, telefono)).not.toBeNull();
  expect(await ingesta.ofrecerInformes(chat, telefono)).toBe(true);
  return prisma.mensaje.findFirstOrThrow({ where: { conversacionId: chat, direccion: 'SALIENTE' }, orderBy: { createdAt: 'desc' } });
}
function respuesta(contexto: string, opcion = `INFORME_${informe.id}`) {
  return { id: `wamid.in.${randomUUID()}`, from: telefono.slice(1), type: 'interactive', timestamp: String(Math.floor(Date.now() / 1000)),
    context: { id: contexto }, interactive: { type: 'list_reply', list_reply: { id: opcion, title: 'Texto no confiable del teléfono' } } };
}
async function webhook(raw: ReturnType<typeof respuesta>) {
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'meta-informes-test' }, messages: [raw] } }] }] });
  return fetch(base + '/webhooks/whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json',
    'x-hub-signature-256': `sha256=${createHmac('sha256', secretoSintetico).update(body).digest('hex')}` }, body });
}
const documentos = () => prisma.mensaje.findMany({ where: { conversacionId: chat, tipo: 'DOCUMENTO', direccion: 'SALIENTE' } });
beforeAll(async () => {
  app = await NestFactory.create(ModuloInformesTest, { rawBody: true, logger: false, abortOnError: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0, '127.0.0.1'); base = await app.getUrl(); ingesta = app.get(IngestaWhatsappService);
}, 30000);
beforeEach(async () => {
  await limpiar();
  process.env.WHATSAPP_INTERACCIONES = 'on'; process.env.WHATSAPP_INTERACCIONES_LINEAS = 'todas';
  process.env.WHATSAPP_INTERACCIONES_KEY = Buffer.alloc(32, 11).toString('base64');
  transporte.enviar.mockReset().mockImplementation(async () => ({ estado: 'ENVIADO', metaMsgId: `wamid.out.${randomUUID()}` }));
  transporte.subirPdf.mockReset().mockResolvedValue('123456');
  portal.informesDelPaciente.mockReset().mockResolvedValue({ datos: [informe], total: 1, pagina: 1, limite: 7 });
  portal.pdfDelPaciente.mockReset().mockResolvedValue(Buffer.from('%PDF-sintetico'));
  linea = (await prisma.lineaWhatsapp.create({ data: { nombre: 'INFORMES-TEST', telefono: '+59170005999', phoneNumberId: 'meta-informes-test', tokenEnv: 'TOKEN_INEXISTENTE_INFORMES', comercial: false, activa: true } })).id;
  process.env.RESULTADOS_AUTOSERVICIO_LINEAS = linea;
  paciente = (await prisma.cliente.create({ data: { nombre: 'Paciente sintético', telefono, pac: 'PAC-TEST', ci: 'CI-TEST' } })).id;
  chat = (await prisma.conversacion.create({ data: { clienteId: paciente, lineaId: linea } })).id;
  await prisma.mensaje.create({ data: { conversacionId: chat, direccion: 'ENTRANTE', contenido: 'Mis informes' } });
});
afterAll(async () => { await limpiar(); await app?.close(); await prisma.$disconnect(); });

it('webhook firmado → respuesta y documento en PostgreSQL → PDF por el despachador, sin URL pública', async () => {
  const lista = await oferta(); const raw = respuesta(lista.whatsappMsgId!);
  expect((await webhook(raw)).status).toBe(200);
  await esperar(async () => (await documentos())[0]?.estadoEnvio === 'ENVIADO');
  const recibido = await prisma.mensaje.findUniqueOrThrow({ where: { whatsappMsgId: raw.id }, include: { interaccion: true } });
  expect(recibido.interaccion?.estado).toBe('CORRELACIONADA');
  expect(recibido.interaccion?.vista).toMatchObject({ proposito: 'INFORMES', seleccionId: `INFORME_${informe.id}` });
  expect(portal.pdfDelPaciente).toHaveBeenCalledWith({ pac: 'PAC-TEST', ci: 'CI-TEST' }, informe);
  expect(transporte.enviar).toHaveBeenLastCalledWith(telefono, expect.objectContaining({ type: 'document', document: expect.objectContaining({ id: '123456', filename: 'informe.pdf' }) }), expect.any(String), expect.anything());
  expect(JSON.stringify(transporte.enviar.mock.calls.at(-1))).not.toContain('https://');
  expect((await webhook(raw)).status).toBe(200);
  expect(await documentos()).toHaveLength(1); expect(transporte.subirPdf).toHaveBeenCalledTimes(1);
});

it('dos selecciones simultáneas de la misma lista producen una sola intención de PDF', async () => {
  const lista = await oferta();
  await Promise.all([webhook(respuesta(lista.whatsappMsgId!)), webhook(respuesta(lista.whatsappMsgId!))]);
  await esperar(async () => (await documentos()).length === 1);
  await esperar(async () => { const d = (await documentos())[0]; return d.estadoEnvio === 'ENVIADO' || (d.estadoEnvio === 'FALLIDO' && !d.permiteReintento); });
  expect(await documentos()).toHaveLength(1);
  expect(await prisma.interaccionMensaje.count({ where: { mensaje: { conversacionId: chat, direccion: 'ENTRANTE' }, estado: 'CORRELACIONADA' } })).toBe(1);
});

it.each(['PAC', 'CI', 'HUMANO', 'CERRADA', 'LINEA', 'VENTANA'] as const)('revalida %s antes de revelar el PDF', async caso => {
  const lista = await oferta();
  if (caso === 'PAC') await prisma.cliente.update({ where: { id: paciente }, data: { pac: 'PAC-OTRO' } });
  if (caso === 'CI') await prisma.cliente.update({ where: { id: paciente }, data: { ci: 'CI-OTRO' } });
  if (caso === 'HUMANO') await prisma.conversacion.update({ where: { id: chat }, data: { atencionTomadaEn: new Date() } });
  if (caso === 'CERRADA') await prisma.conversacion.update({ where: { id: chat }, data: { cerradaEn: new Date() } });
  if (caso === 'LINEA') process.env.RESULTADOS_AUTOSERVICIO_LINEAS = '';
  if (caso === 'VENTANA') await prisma.mensaje.updateMany({ where: { conversacionId: chat, direccion: 'ENTRANTE' }, data: { createdAt: new Date(Date.now() - 25 * 3600000) } });
  const servicio = app.get(InformesChatService);
  const interaccion = await prisma.interaccionMensaje.findUniqueOrThrow({ where: { mensajeId: lista.id } });
  const { descifrarInteraccion } = await import('./interacciones-integracion');
  await expect(servicio.validarOferta(chat, telefono, descifrarInteraccion(interaccion.privado!, lista.clientMessageId!) as OfertaInteraccion)).rejects.toThrow();
  expect(transporte.subirPdf).not.toHaveBeenCalled();
});

it('sin PAC no busca por nombre o CI, responde sin datos y deriva a recepción', async () => {
  await prisma.cliente.update({ where: { id: paciente }, data: { pac: null } });
  expect(await ingesta.ofrecerInformes(chat, telefono)).toBe(false);
  expect(portal.informesDelPaciente).not.toHaveBeenCalled();
  expect((await prisma.conversacion.findUniqueOrThrow({ where: { id: chat } })).automatizacionPausadaEn).not.toBeNull();
});

it('un documento retirado mientras se transfiere a Meta no se envía al paciente', async () => {
  const lista = await oferta(); portal.informesDelPaciente.mockResolvedValue({ datos: [], total: 0, pagina: 1, limite: 7 });
  await webhook(respuesta(lista.whatsappMsgId!));
  await esperar(async () => { const d = (await documentos())[0]; return d?.estadoEnvio === 'FALLIDO' && !d.permiteReintento; });
  expect(transporte.enviar.mock.calls.filter(c => (c[1] as { type: string }).type === 'document')).toHaveLength(0);
});

it('un resultado incierto no se reenvía ni siquiera desde un despachador reiniciado', async () => {
  const lista = await oferta(); transporte.enviar.mockResolvedValue({ estado: 'INCIERTO', motivo: 'timeout sintético' });
  await webhook(respuesta(lista.whatsappMsgId!));
  await esperar(async () => (await documentos())[0]?.estadoEnvio === 'INCIERTO');
  // Esperar que termine el intento en curso antes de simular el reinicio.
  await esperar(async () => transporte.enviar.mock.calls.length === 2);
  const doc = (await documentos())[0];
  const nuevo = new DespachadorSalienteService(prisma, app.get(ConversacionesGateway),
    app.get(R2Service), transporte as unknown as WhatsappCloudService, app.get(LineasWhatsappService), app.get(InformesChatService));
  await nuevo.texto({ mensajeId: doc.id, conversacionId: chat, telefono }, doc.contenido, { key: doc.mediaKey!, mime: 'application/pdf', nombre: 'informe.pdf' });
  expect(transporte.subirPdf).toHaveBeenCalledTimes(1);
  expect(transporte.enviar).toHaveBeenCalledTimes(2);
});

it('selección caducada nunca descarga un documento', async () => {
  const lista = await oferta();
  await prisma.interaccionMensaje.update({ where: { mensajeId: lista.id }, data: { venceEn: new Date(0) } });
  await webhook(respuesta(lista.whatsappMsgId!));
  expect(await documentos()).toHaveLength(0);
  expect(portal.pdfDelPaciente).not.toHaveBeenCalled();
});

it('si no se puede guardar el documento, se revierte la respuesta y la oferta sigue utilizable', async () => {
  const lista = await oferta(); const raw = respuesta(lista.whatsappMsgId!);
  // Fallo real dentro de PostgreSQL descartable, sin simular su transacción.
  await prisma.$executeRawUnsafe(`CREATE FUNCTION informes_test_falla() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."mediaKey" LIKE 'informe-chat/%' THEN RAISE EXCEPTION 'Fallo sintético de persistencia'; END IF; RETURN NEW; END $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER informes_test_falla BEFORE INSERT ON "Mensaje" FOR EACH ROW EXECUTE FUNCTION informes_test_falla()`);
  try {
    expect((await webhook(raw)).status).toBe(503);
    expect(await prisma.mensaje.findUnique({ where: { whatsappMsgId: raw.id } })).toBeNull();
    expect((await prisma.interaccionMensaje.findUniqueOrThrow({ where: { mensajeId: lista.id } })).estado).toBe('OFRECIDA');
    expect(await documentos()).toHaveLength(0); expect(transporte.subirPdf).not.toHaveBeenCalled();
  } finally {
    await prisma.$executeRawUnsafe('DROP TRIGGER informes_test_falla ON "Mensaje"');
    await prisma.$executeRawUnsafe('DROP FUNCTION informes_test_falla()');
  }
  expect((await webhook(raw)).status).toBe(200);
  await esperar(async () => (await documentos())[0]?.estadoEnvio === 'ENVIADO');
});

it('un despachador nuevo reconstruye el PDF pendiente desde la intención persistida', async () => {
  const lista = await oferta();
  const detenido = jest.spyOn(app.get(DespachadorSalienteService), 'texto').mockResolvedValueOnce();
  await webhook(respuesta(lista.whatsappMsgId!));
  await esperar(async () => detenido.mock.calls.length === 1);
  detenido.mockRestore();
  const doc = (await documentos())[0];
  expect(doc.estadoEnvio).toBe('FALLIDO'); expect(transporte.subirPdf).not.toHaveBeenCalled();
  const nuevo = new DespachadorSalienteService(prisma, app.get(ConversacionesGateway), app.get(R2Service),
    transporte as unknown as WhatsappCloudService, app.get(LineasWhatsappService), new InformesChatService(prisma, portal as unknown as PortalResultadosClient));
  await nuevo.texto({ mensajeId: doc.id, conversacionId: chat, telefono }, doc.contenido, { key: doc.mediaKey! });
  expect((await documentos())[0].estadoEnvio).toBe('ENVIADO'); expect(transporte.subirPdf).toHaveBeenCalledTimes(1);
});

it('una opción no ofrecida nunca autoriza un informe', async () => {
  const lista = await oferta(); await webhook(respuesta(lista.whatsappMsgId!, `INFORME_${randomUUID()}`));
  expect(await documentos()).toHaveLength(0); expect(portal.pdfDelPaciente).not.toHaveBeenCalled();
});

it('la selección no sirve en otra conversación, línea ni teléfono', async () => {
  const lista = await oferta(); const raw = respuesta(lista.whatsappMsgId!);
  // Guardar la respuesta válidamente, sin que el PDF alcance Meta todavía.
  const detenido = jest.spyOn(app.get(DespachadorSalienteService), 'texto').mockResolvedValueOnce();
  await webhook(raw); await esperar(async () => detenido.mock.calls.length === 1); detenido.mockRestore();
  const respuestaDb = await prisma.mensaje.findUniqueOrThrow({ where: { whatsappMsgId: raw.id } });
  const otra = await prisma.lineaWhatsapp.create({ data: { nombre: 'INFORMES-TEST', tokenEnv: 'INEXISTENTE', activa: true } });
  const otroChat = await prisma.conversacion.create({ data: { clienteId: paciente, lineaId: otra.id } });
  process.env.RESULTADOS_AUTOSERVICIO_LINEAS += `,${otra.id}`;
  await expect(app.get(InformesChatService).seleccion(otroChat.id, telefono, respuestaDb.id)).rejects.toThrow();
  await expect(app.get(InformesChatService).seleccion(chat, '+59170005902', respuestaDb.id)).rejects.toThrow();
  expect(transporte.subirPdf).not.toHaveBeenCalled();
});

it('pagina con hasta diez opciones y navegar no crea un documento', async () => {
  portal.informesDelPaciente.mockResolvedValue({ datos: Array.from({ length: 7 }, (_, n) => ({ ...informe, id: randomUUID(), estudio: `Estudio ${n}` })), total: 21, pagina: 2, limite: 7 });
  const o = await app.get(InformesChatService).oferta(chat, telefono, 2);
  expect(o?.mensaje.tipo).toBe('lista');
  if (o?.mensaje.tipo !== 'lista') throw new Error('Lista esperada');
  expect(o.mensaje.secciones.flatMap(s => s.opciones)).toHaveLength(10);
  const lista = await oferta();
  await webhook(respuesta(lista.whatsappMsgId!, 'INFORMES_PAGINA_2'));
  await esperar(async () => transporte.enviar.mock.calls.length === 2);
  expect(await documentos()).toHaveLength(0);
  expect(portal.informesDelPaciente).toHaveBeenLastCalledWith({ pac: 'PAC-TEST', ci: 'CI-TEST' }, 2);
});

it('cambiar una conversación a otra línea permitida invalida la lista original', async () => {
  const o = await app.get(InformesChatService).oferta(chat, telefono);
  const otra = await prisma.lineaWhatsapp.create({ data: { nombre: 'INFORMES-TEST', tokenEnv: 'INEXISTENTE', activa: true } });
  process.env.RESULTADOS_AUTOSERVICIO_LINEAS += `,${otra.id}`;
  await prisma.conversacion.update({ where: { id: chat }, data: { lineaId: otra.id } });
  await expect(app.get(InformesChatService).validarOferta(chat, telefono, o!)).rejects.toThrow();
});
