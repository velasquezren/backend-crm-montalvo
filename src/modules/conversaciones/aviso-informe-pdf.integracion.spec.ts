import { PromocionesChatService } from './promociones-chat.service';
import { CobrosService } from '../cobros/cobros.service';
import { PromocionesService } from '../promociones/promociones.service';
import { VentasService } from '../ventas/ventas.service';
import { ConversionesMetaService } from '../conversiones-meta/conversiones-meta.service';
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
import { InformesChatService } from '../resultados/informes-chat.service';
import { PortalResultadosClient } from '../resultados/portal-resultados.client';
import { RESPUESTA_PDF_AVISO } from '../resultados/aviso-informe-pdf';

/*
 * «Recibir PDF» del aviso de resultado, de punta a punta: el aviso sale con el
 * payload, el toque llega por el webhook firmado y el PDF sale por el
 * despachador. PostgreSQL real (`crm_test`); solo Meta y Resultados simulados.
 */
const prisma = new PrismaService('postgresql://crm_app@127.0.0.1:5433/crm_test');
const secretoSintetico = 'firma-sintetica-aviso-pdf';
const config = new ConfigService({ META_APP_SECRET: secretoSintetico, UBICACION_AUTOMATICA: 'off', TOKEN_AVISO_PDF: 'sintetico' });
const transporte = { enviar: jest.fn<Promise<ResultadoEnvio>, unknown[]>(), subirPdf: jest.fn(), listarPlantillas: jest.fn() };
const portal = { informesDelPaciente: jest.fn(), pdfDelPaciente: jest.fn() };
const telefono = '+59170005911';
const correo = 'asistente-aviso-pdf@test.local';
const informe = { id: '5b0e3a9e-7a51-4c55-9a0e-6f1d2f6a0b11', archivoId: '5b0e3a9e-7a51-4c55-9a0e-6f1d2f6a0b12', estudio: 'Estudio sintético', fechaEstudio: '2026-10-01T00:00:00.000Z' };
const PLANTILLA = 'montalvo_informe_pdf';
const plantillaMeta = (conBoton: boolean) => ({
  name: PLANTILLA, language: 'es', status: 'APPROVED', category: 'UTILITY',
  components: [
    { type: 'BODY', text: 'Clínica Montalvo: su informe médico ya está disponible.' },
    { type: 'BUTTONS', buttons: [
      { type: 'URL', text: 'Ver mi informe', url: 'https://resultados.example/resultados/{{1}}' },
      ...(conBoton ? [{ type: 'QUICK_REPLY', text: 'Recibir PDF' }] : []),
    ] },
  ],
});

@Module({
  imports: [JwtModule.register({ secret: 'jwt-sintetico-aviso-pdf', signOptions: { expiresIn: '15m' } })],
  controllers: [ConversacionesController, WhatsappWebhookController],
  providers: [
    { provide: PrismaService, useValue: prisma }, { provide: ConfigService, useValue: config },
    AuditService, AuthService, UsuariosService, ClientesService, CategoriaPacienteService, ServiciosService, TipoCambioService,
    LineasWhatsappService, PrimerContactoService, MemoriaAgenteService, ConversacionesService, EnvioPlantillasService, AtencionHumanaService,
    ConversacionesGateway, IngestaWhatsappService, MenuAtencionService, PromocionesChatService, CobrosService, PromocionesService, VentasService, ConversionesMetaService, LeadsService, AvisoLandingService, AcuseAutomaticoService, DespachadorSalienteService,
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
class ModuloAvisoPdfTest {}

let app: INestApplication;
let base: string;
let linea: string;
let chat: string;
let paciente: string;
let asistente: string;

async function limpiar() {
  await prisma.cliente.deleteMany({ where: { telefono } });
  await prisma.lineaWhatsapp.deleteMany({ where: { nombre: 'AVISO-PDF-TEST' } });
  await prisma.usuario.deleteMany({ where: { email: correo } });
}
async function esperar(f: () => Promise<boolean>) {
  for (let n = 0; n < 200; n++) { if (await f()) return; await new Promise(r => setTimeout(r, 15)); }
  throw new Error('No terminó la operación');
}

/** El aviso como lo manda `ResultadosService.entregar`: plantilla del sistema y luego la fila del aviso. */
async function avisar(): Promise<string> {
  const mensaje = await app.get(EnvioPlantillasService).enviarPlantillaDelSistema(chat, {
    plantilla: PLANTILLA, idioma: 'es', boton: 'acceso-sintetico', respuestaRapida: RESPUESTA_PDF_AVISO,
    contenido: 'Aviso de resultado disponible — Estudio sintético.',
  }, asistente);
  await esperar(async () => !!(await prisma.mensaje.findUniqueOrThrow({ where: { id: mensaje.id } })).whatsappMsgId);
  await prisma.avisoResultado.create({ data: { informeId: informe.id, clienteId: paciente, enviadoPorId: asistente, mensajeId: mensaje.id } });
  return (await prisma.mensaje.findUniqueOrThrow({ where: { id: mensaje.id } })).whatsappMsgId!;
}

function toque(contexto: string, boton: { payload: string; text: string } = { payload: RESPUESTA_PDF_AVISO, text: 'Recibir PDF' }) {
  return { id: `wamid.in.${randomUUID()}`, from: telefono.slice(1), type: 'button', timestamp: String(Math.floor(Date.now() / 1000)),
    context: { id: contexto }, button: boton };
}
async function webhook(raw: ReturnType<typeof toque>) {
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'meta-aviso-pdf-test' }, messages: [raw] } }] }] });
  return fetch(base + '/webhooks/whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json',
    'x-hub-signature-256': `sha256=${createHmac('sha256', secretoSintetico).update(body).digest('hex')}` }, body });
}
const documentos = () => prisma.mensaje.findMany({ where: { conversacionId: chat, tipo: 'DOCUMENTO', direccion: 'SALIENTE' } });
const enviadosDeTipo = (tipo: string) => transporte.enviar.mock.calls.filter(c => (c[1] as { type: string }).type === tipo);
const terminado = async () => { const d = (await documentos())[0]; return d?.estadoEnvio === 'ENVIADO' || (d?.estadoEnvio === 'FALLIDO' && !d.permiteReintento); };

beforeAll(async () => {
  app = await NestFactory.create(ModuloAvisoPdfTest, { rawBody: true, logger: false, abortOnError: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0, '127.0.0.1'); base = await app.getUrl();
}, 30000);
beforeEach(async () => {
  await limpiar();
  process.env.WHATSAPP_INTERACCIONES = 'on'; process.env.WHATSAPP_INTERACCIONES_LINEAS = 'todas';
  process.env.WHATSAPP_INTERACCIONES_KEY = Buffer.alloc(32, 12).toString('base64');
  transporte.enviar.mockReset().mockImplementation(async () => ({ estado: 'ENVIADO', metaMsgId: `wamid.out.${randomUUID()}` }));
  transporte.subirPdf.mockReset().mockResolvedValue('654321');
  transporte.listarPlantillas.mockReset().mockResolvedValue([plantillaMeta(true)]);
  portal.informesDelPaciente.mockReset().mockResolvedValue({ datos: [informe], total: 1, pagina: 1, limite: 7 });
  portal.pdfDelPaciente.mockReset().mockResolvedValue(Buffer.from('%PDF-sintetico'));
  linea = (await prisma.lineaWhatsapp.create({ data: { nombre: 'AVISO-PDF-TEST', telefono: '+59170005998', phoneNumberId: 'meta-aviso-pdf-test', tokenEnv: 'TOKEN_AVISO_PDF', comercial: false, activa: true } })).id;
  process.env.RESULTADOS_AUTOSERVICIO_LINEAS = linea;
  asistente = (await prisma.usuario.create({ data: { nombre: 'Asistente sintética', email: correo, passwordHash: 'x', rol: 'ASISTENTE' } })).id;
  paciente = (await prisma.cliente.create({ data: { nombre: 'Paciente sintético', telefono, pac: 'PAC-AVISO', ci: 'CI-AVISO' } })).id;
  chat = (await prisma.conversacion.create({ data: { clienteId: paciente, lineaId: linea } })).id;
});
afterAll(async () => { await limpiar(); await app?.close(); await prisma.$disconnect(); });

it('el aviso sale con el payload en el botón de respuesta rápida, además del enlace', async () => {
  await avisar();
  const plantilla = enviadosDeTipo('template')[0][1] as { template: { components: unknown[] } };
  expect(plantilla.template.components).toEqual(expect.arrayContaining([
    { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: RESPUESTA_PDF_AVISO }] },
    { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'acceso-sintetico' }] },
  ]));
});

it('con la plantilla de siempre (sin «Recibir PDF») no agrega ningún botón', async () => {
  transporte.listarPlantillas.mockResolvedValue([plantillaMeta(false)]);
  await avisar();
  const plantilla = enviadosDeTipo('template')[0][1] as { template: { components: { sub_type?: string }[] } };
  expect(plantilla.template.components.map(c => c.sub_type)).toEqual(['url']);
});

it('«Recibir PDF» → el PDF de ESE informe por el chat, sin pedir a una persona', async () => {
  const raw = toque(await avisar());
  expect((await webhook(raw)).status).toBe(200);
  await esperar(async () => (await documentos())[0]?.estadoEnvio === 'ENVIADO');
  expect(portal.pdfDelPaciente).toHaveBeenCalledWith({ pac: 'PAC-AVISO', ci: 'CI-AVISO' }, informe);
  expect(enviadosDeTipo('document')).toHaveLength(1);
  expect(enviadosDeTipo('document')[0][1]).toMatchObject({ document: { id: '654321', filename: 'informe.pdf' } });
  const recibido = await prisma.mensaje.findUniqueOrThrow({ where: { whatsappMsgId: raw.id }, include: { interaccion: true } });
  expect(recibido.contenido).toBe('Recibir PDF');
  expect(recibido.interaccion?.vista).toMatchObject({ estado: 'CORRELACIONADA', proposito: 'INFORMES', seleccionId: RESPUESTA_PDF_AVISO });
  expect((await prisma.conversacion.findUniqueOrThrow({ where: { id: chat } })).atencionMotivo).toBeNull();
  /* Un reintento del mismo webhook no manda otro. */
  expect((await webhook(raw)).status).toBe(200);
  expect(await documentos()).toHaveLength(1);
});

it('sale aunque una persona esté atendiendo el chat', async () => {
  const contexto = await avisar();
  await prisma.conversacion.update({ where: { id: chat }, data: { atencionTomadaEn: new Date(), atencionTomadaPorId: asistente } });
  await webhook(toque(contexto));
  await esperar(async () => (await documentos())[0]?.estadoEnvio === 'ENVIADO');
});

it('sin payload (Meta devuelve el rótulo) también lo reconoce', async () => {
  await webhook(toque(await avisar(), { payload: 'Recibir PDF', text: 'Recibir PDF' }));
  await esperar(async () => (await documentos())[0]?.estadoEnvio === 'ENVIADO');
});

it('dos toques seguidos mandan un solo PDF', async () => {
  const contexto = await avisar();
  await webhook(toque(contexto));
  await esperar(terminado);
  await webhook(toque(contexto));
  await esperar(async () => (await prisma.interaccionMensaje.count({ where: { estado: 'DUPLICADA', mensaje: { conversacionId: chat } } })) === 1);
  expect(await documentos()).toHaveLength(1);
  expect(transporte.subirPdf).toHaveBeenCalledTimes(1);
});

it('si el informe ya no está vigente para ese PAC, no manda nada y lo ve una persona', async () => {
  const contexto = await avisar();
  portal.informesDelPaciente.mockResolvedValue({ datos: [], total: 0, pagina: 1, limite: 7 });
  await webhook(toque(contexto));
  await esperar(terminado);
  expect(enviadosDeTipo('document')).toHaveLength(0);
  expect(portal.pdfDelPaciente).not.toHaveBeenCalled();
  expect((await prisma.conversacion.findUniqueOrThrow({ where: { id: chat } })).atencionMotivo).toBe('REVISION');
});

it('el aviso de un informe que está en otra página del portal también se encuentra', async () => {
  const contexto = await avisar();
  const otros = Array.from({ length: 7 }, () => ({ ...informe, id: randomUUID(), archivoId: randomUUID() }));
  portal.informesDelPaciente.mockImplementation(async (_: unknown, pagina: number) =>
    pagina === 1 ? { datos: otros, total: 8, pagina: 1, limite: 7 } : { datos: [informe], total: 8, pagina: 2, limite: 7 });
  await webhook(toque(contexto));
  await esperar(async () => (await documentos())[0]?.estadoEnvio === 'ENVIADO');
  expect(portal.pdfDelPaciente).toHaveBeenCalledWith({ pac: 'PAC-AVISO', ci: 'CI-AVISO' }, informe);
});

it('si la ficha cambió de PAC desde el aviso, no sale el PDF', async () => {
  const contexto = await avisar();
  await prisma.cliente.update({ where: { id: paciente }, data: { pac: 'PAC-OTRO' } });
  portal.informesDelPaciente.mockImplementation(async (identidad: { pac: string }) =>
    identidad.pac === 'PAC-AVISO' ? { datos: [informe], total: 1, pagina: 1, limite: 7 } : { datos: [], total: 0, pagina: 1, limite: 7 });
  await webhook(toque(contexto));
  await esperar(terminado);
  expect(enviadosDeTipo('document')).toHaveLength(0);
});

it('«Recibir PDF» sobre un mensaje que no es un aviso no autoriza nada', async () => {
  await avisar();
  const otro = await prisma.mensaje.create({ data: { conversacionId: chat, direccion: 'SALIENTE', contenido: 'Otro mensaje', whatsappMsgId: `wamid.otro.${randomUUID()}` } });
  await webhook(toque(otro.whatsappMsgId!));
  await esperar(async () => (await prisma.conversacion.findUniqueOrThrow({ where: { id: chat } })).atencionMotivo !== null);
  expect(await documentos()).toHaveLength(0);
});

it('en una línea sin autoservicio de informes no sale el PDF y lo ve una persona', async () => {
  const contexto = await avisar();
  process.env.RESULTADOS_AUTOSERVICIO_LINEAS = '';
  await webhook(toque(contexto));
  await esperar(async () => (await prisma.conversacion.findUniqueOrThrow({ where: { id: chat } })).atencionMotivo === 'REVISION');
  expect(await documentos()).toHaveLength(0);
});
