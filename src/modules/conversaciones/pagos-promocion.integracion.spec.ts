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
import { AvisoLandingService } from '../../common/landing/aviso-landing.service';
import { PushService } from '../../common/push/push.service';
import { R2Service } from '../../common/storage/r2.service';
import { WhatsappCloudService, ResultadoEnvio } from '../../common/whatsapp/whatsapp-cloud.service';
import { AlertasWhatsappService } from '../../common/whatsapp/alertas-whatsapp.service';
import { Rol } from '../../prisma/prisma-client';
import { AuthService } from '../auth/auth.service';
import { UsuariosService } from '../usuarios/usuarios.service';
import { ClientesService } from '../clientes/clientes.service';
import { CategoriaPacienteService } from '../clientes/categoria-paciente.service';
import { ServiciosService } from '../servicios/servicios.service';
import { TipoCambioService } from '../tipo-cambio/tipo-cambio.service';
import { LineasWhatsappService } from '../lineas-whatsapp/lineas-whatsapp.service';
import { LeadsService } from '../leads/leads.service';
import { PrimerContactoService } from '../leads/primer-contacto.service';
import { MemoriaAgenteService } from '../memoria-agente/memoria-agente.service';
import { MenuAtencionController } from '../menu-atencion/menu-atencion.controller';
import { MenuAtencionService } from '../menu-atencion/menu-atencion.service';
import { CobrosController } from '../cobros/cobros.controller';
import { CobrosService } from '../cobros/cobros.service';
import { PromocionesService } from '../promociones/promociones.service';
import { VentasService } from '../ventas/ventas.service';
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
import { PromocionesChatService } from './promociones-chat.service';
import { WhatsappWebhookController } from './webhooks/whatsapp-webhook.controller';

/*
 * Una promoción de la landing al pago confirmado, de punta a punta
 * (docs/pagos-promocion.md): webhook firmado, Postgres real, HTTP con los guards
 * reales y un R2 en memoria. Meta es lo único simulado: nada sale de esta máquina.
 */

// URL deliberadamente fija; nunca usar DATABASE_URL ni cargar .env en esta suite.
const prisma = new PrismaService('postgresql://crm_app@127.0.0.1:5433/crm_test');
const claveSintetica = Buffer.alloc(32, 13).toString('base64');
const secretoSintetico = 'firma-webhook-sintetica-pagos';
const transporte = { enviar: jest.fn<Promise<ResultadoEnvio>, unknown[]>(), listarPlantillas: jest.fn() };
const config = new ConfigService({
  META_APP_SECRET: secretoSintetico,
  AUTORESPUESTA_TEXTO: 'Acuse sintético fuera de horario.',
  AUTORESPUESTA_HORARIO: 'D:03:00-03:01',
  UBICACION_AUTOMATICA: 'off',
});

/** R2 en memoria con el mismo contrato que el real. */
const almacen = new Map<string, { bytes: Uint8Array; mime: string }>();
const r2 = {
  habilitado: true,
  async subir(clave: string, cuerpo: ArrayBuffer, mime: string) { almacen.set(clave, { bytes: new Uint8Array(cuerpo), mime }); },
  async leer(clave: string) {
    const o = almacen.get(clave);
    if (!o) return null;
    return { cuerpo: new Blob([Uint8Array.from(o.bytes)]).stream(), tipo: o.mime, bytes: o.bytes.byteLength };
  },
  async eliminar(clave: string) { almacen.delete(clave); },
  async urlFirmada(clave: string) { return `https://r2.invalid/${clave}?firmada`; },
};

@Module({
  imports: [JwtModule.register({ secret: 'jwt-sintetico-pagos', signOptions: { expiresIn: '15m' } })],
  controllers: [ConversacionesController, WhatsappWebhookController, MenuAtencionController, CobrosController],
  providers: [
    { provide: PrismaService, useValue: prisma }, { provide: ConfigService, useValue: config },
    AuditService, AuthService, UsuariosService, ClientesService, CategoriaPacienteService, ServiciosService, TipoCambioService,
    LineasWhatsappService, LeadsService, PrimerContactoService, MemoriaAgenteService, ConversacionesService, EnvioPlantillasService,
    AtencionHumanaService, ConversacionesGateway, IngestaWhatsappService, MenuAtencionService, AcuseAutomaticoService,
    DespachadorSalienteService, ReintentoSalienteService, CierreInactividadService, MetaSignatureGuard,
    PromocionesChatService, CobrosService, PromocionesService, VentasService, AvisoLandingService,
    { provide: WhatsappCloudService, useValue: transporte },
    { provide: R2Service, useValue: r2 },
    { provide: PushService, useValue: { enviarAUsuario: async () => undefined } },
    { provide: AlertasWhatsappService, useValue: { procesar: async () => undefined } },
    { provide: MediaEntranteService, useValue: { despertar: () => undefined } },
    { provide: APP_GUARD, useClass: JwtAuthGuard }, { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
class ModuloPagosTest {}

const PREFIJO_TEL = '+591700029';
const telefono = `${PREFIJO_TEL}01`;
const PHONE_VENTAS = 'meta-pagos-ventas';
const envOriginal = {
  flag: process.env['WHATSAPP_INTERACCIONES'],
  key: process.env['WHATSAPP_INTERACCIONES_KEY'],
  url: process.env['CRM_URL_PUBLICA'],
};

let app: INestApplication;
let base: string;
let ventas: string;
let promocionId: string;
const CODIGO = 'PRM-7K3QX';
const usuarios: Record<'admin' | 'agente', { id: string; token: string }> = {} as never;

/** Cabecera PNG mínima: basta para leer ancho y alto. */
function png(ancho: number, alto: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 0);
  new DataView(b.buffer).setUint32(16, ancho);
  new DataView(b.buffer).setUint32(20, alto);
  return b;
}
async function http(ruta: string, metodo = 'GET', bearer = usuarios.agente.token, cuerpo?: unknown) {
  const r = await fetch(base + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}
async function webhook(mensajes: unknown[]) {
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: PHONE_VENTAS }, messages: mensajes } }] }] });
  return fetch(base + '/webhooks/whatsapp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', secretoSintetico).update(body).digest('hex')}` },
    body,
  });
}
const ahoraMeta = () => String(Math.floor(Date.now() / 1000));
const texto = (cuerpo: string) => ({ id: `wamid.in.${randomUUID()}`, from: telefono.slice(1), type: 'text', timestamp: ahoraMeta(), text: { body: cuerpo } });
const foto = () => ({ id: `wamid.in.${randomUUID()}`, from: telefono.slice(1), type: 'image', timestamp: ahoraMeta(), image: { id: `media-${randomUUID()}`, mime_type: 'image/jpeg' } });
const toque = (contexto: string, opcion: string, tipo: 'button_reply' | 'list_reply' = 'button_reply') =>
  ({ id: `wamid.in.${randomUUID()}`, from: telefono.slice(1), type: 'interactive', timestamp: ahoraMeta(), context: { id: contexto }, interactive: { type: tipo, [tipo]: { id: opcion, title: 'Título del teléfono' } } });

async function esperar(condicion: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 150; i++) { if (await condicion()) return; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('La condición no se cumplió a tiempo');
}
const reposo = () => new Promise(r => setTimeout(r, 300));
const chat = async () => prisma.conversacion.findFirstOrThrow({ where: { lineaId: ventas, cliente: { telefono } } });
const envios = () => transporte.enviar.mock.calls.map(c => JSON.stringify(c[1]));
async function ofertas(conversacionId: string) {
  return prisma.mensaje.findMany({ where: { conversacionId, automatico: true, interaccion: { isNot: null }, whatsappMsgId: { not: null } }, orderBy: { createdAt: 'asc' } });
}
async function textosAutomaticos(conversacionId: string) {
  return (await prisma.mensaje.findMany({ where: { conversacionId, automatico: true, interaccion: { is: null } }, orderBy: { createdAt: 'asc' } })).map(m => m.contenido);
}

/** Escribe con el código de la landing y devuelve el chat y el wamid de la tarjeta. */
async function llegarPorLaLanding() {
  expect((await webhook([texto(`Hola, me interesa la promoción «Control prenatal» (${CODIGO}).`)])).status).toBe(200);
  const c = await chat();
  await esperar(async () => (await ofertas(c.id)).length === 1);
  return { chat: c.id, tarjeta: (await ofertas(c.id))[0].whatsappMsgId! };
}
/** «Pagar ahora» y espera el QR. */
async function pagar(chatId: string, tarjeta: string) {
  expect((await webhook([toque(tarjeta, 'PAGAR_PROMOCION')])).status).toBe(200);
  await esperar(async () => !!(await prisma.pagoPromocion.findFirst({ where: { conversacionId: chatId, estado: 'PENDIENTE' } })));
  await esperar(async () => !!(await prisma.mensaje.findFirst({ where: { conversacionId: chatId, automatico: true, tipo: 'IMAGEN', whatsappMsgId: { not: null } } })));
}
/** Manda la foto del comprobante y simula que su descarga a R2 ya terminó. */
async function mandarComprobante(chatId: string) {
  const m = foto();
  expect((await webhook([m])).status).toBe(200);
  const fila = await prisma.mensaje.findUniqueOrThrow({ where: { whatsappMsgId: m.id } });
  const clave = `wa/${chatId}/${fila.id}`;
  almacen.set(clave, { bytes: png(600, 900), mime: 'image/jpeg' });
  await prisma.mensaje.update({ where: { id: fila.id }, data: { mediaKey: clave } });
  return fila.id;
}
const pagoAbierto = async (chatId: string) => prisma.pagoPromocion.findFirstOrThrow({ where: { conversacionId: chatId }, orderBy: { createdAt: 'desc' } });

async function configurarCobro(activo = true) {
  const form = new FormData();
  form.append('archivo', new Blob([Uint8Array.from(png(600, 600))], { type: 'image/png' }), 'qr.png');
  const subida = await fetch(`${base}/cobros/${ventas}/qr`, { method: 'PUT', headers: { Authorization: `Bearer ${usuarios.admin.token}` }, body: form });
  expect(subida.status).toBe(200);
  const r = await http(`/cobros/${ventas}`, 'PUT', usuarios.admin.token, { activo, banco: 'Banco Sintético', titular: 'Clínica Sintética SRL', instrucciones: 'Pon tu nombre en la glosa.' });
  expect(r.status).toBe(200);
  return r.body;
}

async function limpiar() {
  /* En orden de dependencias: los pagos apuntan a la línea y a la promoción (RESTRICT)
     y las ventas a la paciente. */
  await prisma.pagoPromocion.deleteMany({ where: { linea: { nombre: { startsWith: 'PAGOS-' } } } });
  await prisma.venta.deleteMany({ where: { cliente: { telefono: { startsWith: PREFIJO_TEL } } } });
  await prisma.cliente.deleteMany({ where: { telefono: { startsWith: PREFIJO_TEL } } });
  const ids = (await prisma.usuario.findMany({ where: { email: { endsWith: '@pagos.test' } }, select: { id: true } })).map(u => u.id);
  await prisma.auditLog.deleteMany({ where: { OR: [{ usuarioId: { in: ids } }, { entidad: { in: ['PagoPromocion', 'Conversacion'] } }] } });
  await prisma.promocion.deleteMany({ where: { codigo: { in: [CODIGO, 'PRM-VENC2'] } } });
  await prisma.lineaWhatsapp.deleteMany({ where: { nombre: { startsWith: 'PAGOS-' } } });
  await prisma.usuario.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
  process.env['WHATSAPP_INTERACCIONES'] = 'on';
  process.env['WHATSAPP_INTERACCIONES_KEY'] = claveSintetica;
  process.env['CRM_URL_PUBLICA'] = 'https://crm.sintetico.test';
  const nueva = await NestFactory.create(ModuloPagosTest, { rawBody: true, logger: false, abortOnError: false });
  nueva.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await nueva.listen(0, '127.0.0.1');
  app = nueva;
  base = await app.getUrl();
}, 30_000);

beforeEach(async () => {
  process.env['WHATSAPP_INTERACCIONES'] = 'on';
  await limpiar();
  almacen.clear();
  transporte.enviar.mockReset().mockImplementation(async () => ({ estado: 'ENVIADO', metaMsgId: `wamid.out.${randomUUID()}` }));
  ventas = (await prisma.lineaWhatsapp.create({ data: { nombre: 'PAGOS-ventas', telefono: '+59170002991', phoneNumberId: PHONE_VENTAS, tokenEnv: 'TOKEN_INEXISTENTE_PAGOS', comercial: true } })).id;
  const definiciones: [keyof typeof usuarios, Rol, string[]][] = [['admin', 'SUPER_ADMIN', []], ['agente', 'AGENTE', [ventas]]];
  for (const [clave, rol, lineas] of definiciones) {
    const u = await prisma.usuario.create({ data: {
      nombre: `Persona ${clave}`, email: `${clave}@pagos.test`, passwordHash: await bcrypt.hash('sintetico', 4), rol, activo: true,
      lineasWhatsapp: { create: lineas.map(lineaId => ({ lineaId })) },
    } });
    usuarios[clave] = { id: u.id, token: (await app.get(AuthService).login({ email: u.email, password: 'sintetico' })).access_token };
  }
  const hoy = new Date(); hoy.setUTCHours(0, 0, 0, 0);
  const p = await prisma.promocion.create({ data: {
    codigo: CODIGO, slug: `control-prenatal-${randomUUID().slice(0, 8)}`, titulo: 'Control prenatal', resumen: 'Consulta y ecografía.',
    condiciones: 'Válido de lunes a viernes.', precioRegular: 350, precioPromocional: 280, estado: 'PUBLICADA', publicadaEn: new Date(),
    vigenteDesde: new Date(hoy.getTime() - 86_400_000), vigenteHasta: new Date(hoy.getTime() + 30 * 86_400_000),
    imagenes: { create: { formato: 'CUADRADO', clave: 'promociones/x/banner.png', mime: 'image/png', ancho: 1080, alto: 1080, bytes: 33, textoAlternativo: 'Banner' } },
  } });
  promocionId = p.id;
});

afterAll(async () => {
  await limpiar(); await app?.close(); await prisma.$disconnect();
  for (const [nombre, valor] of [['WHATSAPP_INTERACCIONES', envOriginal.flag], ['WHATSAPP_INTERACCIONES_KEY', envOriginal.key], ['CRM_URL_PUBLICA', envOriginal.url]] as const) {
    if (valor === undefined) delete process.env[nombre]; else process.env[nombre] = valor;
  }
});

describe('el QR de la línea', () => {
  it('solo SUPER_ADMIN lo configura; no se activa sin imagen y no expone la clave de R2', async () => {
    expect((await http(`/cobros/${ventas}`, 'GET', usuarios.agente.token)).status).toBe(403);
    const sinImagen = await http(`/cobros/${ventas}`, 'PUT', usuarios.admin.token, { activo: true, banco: 'Banco', titular: 'Clínica' });
    expect(sinImagen.status).toBe(400);
    const listo = await configurarCobro();
    expect(listo).toMatchObject({ estado: 'LISTO', cobro: { activo: true, banco: 'Banco Sintético' } });
    expect(JSON.stringify(listo)).not.toContain('"imagenClave"');
  });

  it('un QR vencido no se puede activar', async () => {
    await configurarCobro(false);
    const r = await http(`/cobros/${ventas}`, 'PUT', usuarios.admin.token, { activo: true, banco: 'Banco', titular: 'Clínica', venceEl: '2020-01-01' });
    expect(r.status).toBe(400);
  });
});

describe('separación de Atención y Ventas', () => {
  it('Recepción rechaza QR y promociones incluso para admin; conserva mensajes sin crear leads', async () => {
    await prisma.lineaWhatsapp.update({ where: { id: ventas }, data: { comercial: false } });
    expect((await http(`/cobros/${ventas}`, 'GET', usuarios.admin.token)).status).toBe(403);
    expect((await http(`/cobros/${ventas}`, 'PUT', usuarios.admin.token, { activo: false, banco: 'Banco', titular: 'Clínica' })).status).toBe(403);
    expect((await http(`/menu-atencion/${ventas}`, 'PUT', usuarios.admin.token, {
      activo: true, saludo: 'Hola', opciones: [
        { tipo: 'PERSONA', titulo: 'Hablar con alguien' },
        { tipo: 'PROMOCIONES', titulo: 'Promociones', respuesta: 'Elige una promoción' },
      ],
    })).status).toBe(400);
    const entrada = texto(`Me interesa (${CODIGO})`);
    expect((await webhook([entrada])).status).toBe(200);
    expect((await webhook([entrada])).status).toBe(200);
    await reposo();
    const c = await chat();
    expect(await prisma.mensaje.count({ where: { conversacionId: c.id, direccion: 'ENTRANTE' } })).toBe(1);
    expect(await prisma.lead.count({ where: { clienteId: c.clienteId } })).toBe(0);
    expect(await prisma.pagoPromocion.count({ where: { conversacionId: c.id } })).toBe(0);
    expect(transporte.enviar).not.toHaveBeenCalled();
  });

  it('un QR y botón de pago antiguos no permiten cobrar desde Recepción: se pide revisión', async () => {
    await configurarCobro();
    const { chat: id, tarjeta } = await llegarPorLaLanding();
    await reposo();
    await prisma.lineaWhatsapp.update({ where: { id: ventas }, data: { comercial: false } });
    transporte.enviar.mockClear();
    expect(await app.get(CobrosService).listoPara(ventas)).toBeNull();
    const entrada = toque(tarjeta, 'PAGAR_PROMOCION');
    expect((await webhook([entrada])).status).toBe(200);
    expect((await webhook([entrada])).status).toBe(200);
    await reposo();
    expect((await prisma.conversacion.findUniqueOrThrow({ where: { id } })).atencionMotivo).toBe('REVISION');
    expect(await prisma.pagoPromocion.count({ where: { conversacionId: id } })).toBe(0);
    expect(transporte.enviar).not.toHaveBeenCalled();
  });

  it('el reintento de una tarjeta antigua se detiene si la línea ya no es comercial', async () => {
    const { chat: id } = await llegarPorLaLanding();
    await reposo();
    const [tarjeta] = await ofertas(id);
    await prisma.lineaWhatsapp.update({ where: { id: ventas }, data: { comercial: false } });
    await prisma.mensaje.update({ where: { id: tarjeta.id }, data: { estadoEnvio: 'FALLIDO', permiteReintento: true, proximoIntento: new Date() } });
    transporte.enviar.mockClear();
    await app.get(DespachadorSalienteService).interaccion({ mensajeId: tarjeta.id, conversacionId: id, telefono });
    expect(transporte.enviar).not.toHaveBeenCalled();
    expect(await prisma.mensaje.findUniqueOrThrow({ where: { id: tarjeta.id } })).toMatchObject({ estadoEnvio: 'FALLIDO', permiteReintento: false, proximoIntento: null });
  });

  it('el QR encolado antes del cambio no se reenvía por Recepción', async () => {
    await configurarCobro();
    const { chat: id, tarjeta } = await llegarPorLaLanding();
    await pagar(id, tarjeta);
    await reposo();
    const qr = await prisma.mensaje.findFirstOrThrow({ where: { conversacionId: id, tipo: 'IMAGEN', automatico: true } });
    await prisma.lineaWhatsapp.update({ where: { id: ventas }, data: { comercial: false } });
    await prisma.mensaje.update({ where: { id: qr.id }, data: { estadoEnvio: 'FALLIDO', permiteReintento: true, proximoIntento: new Date() } });
    transporte.enviar.mockClear();
    await app.get(DespachadorSalienteService).texto({ mensajeId: qr.id, conversacionId: id, telefono }, qr.contenido, { key: qr.mediaKey!, mime: qr.mediaMime });
    expect(transporte.enviar).not.toHaveBeenCalled();
    expect(await prisma.mensaje.findUniqueOrThrow({ where: { id: qr.id } })).toMatchObject({ estadoEnvio: 'FALLIDO', permiteReintento: false, proximoIntento: null });
  });

  it('Recepción no puede enviar acciones comerciales desde el compositor ni plantillas de marketing', async () => {
    await prisma.lineaWhatsapp.update({ where: { id: ventas }, data: { comercial: false } });
    await webhook([texto('Consulta de atención')]);
    await reposo();
    const c = await chat();
    const interactivo = await http(`/conversaciones/${c.id}/mensajes`, 'POST', usuarios.admin.token, {
      contenido: 'Elige', clientMessageId: randomUUID(), interaccion: {
        tipo: 'botones', cuerpo: 'Elige', opciones: [{ id: 'VIEW_PROMOTIONS', titulo: 'Ver opciones' }],
      },
    });
    expect(interactivo.status).toBe(400);
    transporte.listarPlantillas.mockResolvedValue([
      { name: 'promo', status: 'APPROVED', category: 'MARKETING', language: 'es', components: [{ type: 'BODY', text: 'Promoción' }] },
      { name: 'cita', status: 'APPROVED', category: 'UTILITY', language: 'es', components: [{ type: 'BODY', text: 'Solicitud de cita' }] },
    ]);
    const plantillas = app.get(EnvioPlantillasService);
    expect((await plantillas.listarPlantillas(true, ventas)).map(p => p.nombre)).toEqual(['cita']);
    expect((await plantillas.listarPlantillas(false, ventas)).map(p => p.nombre)).toEqual(['cita']);
    expect((await http(`/conversaciones/${c.id}/plantilla`, 'POST', usuarios.admin.token, { plantilla: 'promo', idioma: 'es', parametros: [] })).status).toBe(400);
    await expect(plantillas.enviarPlantillaDelSistema(c.id, { plantilla: 'promo', idioma: 'es', categoria: 'MARKETING', contenido: 'Promo' }, usuarios.admin.id)).rejects.toMatchObject({ status: 403 });
    expect(await prisma.mensaje.count({ where: { conversacionId: c.id, direccion: 'SALIENTE' } })).toBe(0);
    expect(transporte.enviar).not.toHaveBeenCalled();
    // Utilidad sigue funcionando por la misma tubería.
    expect((await http(`/conversaciones/${c.id}/plantilla`, 'POST', usuarios.admin.token, { plantilla: 'cita', idioma: 'es', parametros: [] })).status).toBe(201);
  });

  it('un rol de Recepción no puede revisar un pago aunque tenga acceso a esa línea', async () => {
    await configurarCobro();
    const { chat: id, tarjeta } = await llegarPorLaLanding();
    await pagar(id, tarjeta);
    await mandarComprobante(id);
    const pago = await pagoAbierto(id);
    const rec = await prisma.usuario.create({ data: {
      nombre: 'Recepción sintética', email: 'rec@pagos.test', passwordHash: await bcrypt.hash('sintetico', 4), rol: 'RECEPCION', activo: true,
      lineasWhatsapp: { create: { lineaId: ventas } },
    } });
    const token = (await app.get(AuthService).login({ email: rec.email, password: 'sintetico' })).access_token;
    for (const accion of ['confirmar', 'pedir-otro', 'anular']) {
      expect((await http(`/conversaciones/${id}/pagos/${pago.id}/${accion}`, 'POST', token, { motivo: 'Comprobante ilegible' })).status).toBe(403);
    }
    expect((await pagoAbierto(id)).estado).toBe('COMPROBANTE_ENVIADO');
  });

  it('no abre un pago utilizando el QR de otra línea comercial', async () => {
    await configurarCobro();
    const { chat: id } = await llegarPorLaLanding();
    const otra = await prisma.lineaWhatsapp.create({ data: { nombre: 'PAGOS-otra', comercial: true, tokenEnv: 'TOKEN_INEXISTENTE_PAGOS' } });
    await prisma.conversacion.update({ where: { id }, data: { lineaId: otra.id } });
    expect(await app.get(PromocionesChatService).iniciar(id, ventas, promocionId)).toBeNull();
    expect(await prisma.pagoPromocion.count({ where: { conversacionId: id } })).toBe(0);
  });

  it('un menú comercial heredado en Recepción queda visible para corregirlo, pero no se envía', async () => {
    await prisma.lineaWhatsapp.update({ where: { id: ventas }, data: { comercial: false } });
    await prisma.menuAtencion.create({ data: { lineaId: ventas, activo: true, saludo: 'Hola', opciones: [
      { tipo: 'PERSONA', titulo: 'Hablar con alguien' },
      { tipo: 'PROMOCIONES', titulo: 'Promociones', respuesta: 'Elige una promoción' },
    ] } });
    const menus = app.get(MenuAtencionService);
    expect((await menus.editable(ventas)).errores).toContain('Las promociones pertenecen a Ventas. Quita esa opción del menú de Atención.');
    expect(await menus.activoDe(ventas)).toBeNull();
    expect(await prisma.menuAtencion.count({ where: { lineaId: ventas } })).toBe(1);
  });
});

describe('de la landing al pago confirmado', () => {
  it('el código responde con la tarjeta (banner, precio, Pagar) y atribuye la promoción a su lead, sin menú ni acuse', async () => {
    await configurarCobro();
    const { chat: id } = await llegarPorLaLanding();
    const tarjeta = envios().find(e => e.includes('"type":"button"'))!;
    expect(tarjeta).toContain('https://crm.sintetico.test/publico/promociones/imagenes/');
    expect(tarjeta).toContain('💰 *Bs 280* ~Bs 350~');
    expect(tarjeta).toContain('PAGAR_PROMOCION');
    await esperar(async () => !!(await prisma.lead.findFirst({ where: { cliente: { telefono }, promocionId } })));
    await reposo();
    expect(await textosAutomaticos(id)).not.toContain('Acuse sintético fuera de horario.');
    const detalle = await http(`/conversaciones/${id}`);
    expect(detalle.body['promocion']).toMatchObject({ codigo: CODIGO, titulo: 'Control prenatal' });
  });

  it('«Hablar con alguien» en la tarjeta pide una persona y recibe su confirmación', async () => {
    const { chat: id, tarjeta } = await llegarPorLaLanding();
    expect((await webhook([toque(tarjeta, 'TALK_TO_HUMAN')])).status).toBe(200);
    await esperar(async () => (await prisma.conversacion.findUniqueOrThrow({ where: { id } })).atencionMotivo === 'SOLICITUD_EXPLICITA');
    await esperar(async () => (await textosAutomaticos(id)).some(t => t.startsWith('Listo. Una persona del equipo te escribirá')));
  });

  it('«Pagar ahora» → QR con monto; la foto → comprobante por verificar; confirmar → venta ligada y aviso a la paciente', async () => {
    await configurarCobro();
    const { chat: id, tarjeta } = await llegarPorLaLanding();
    await pagar(id, tarjeta);
    /* El mensaje que ES una imagen (la tarjeta también lleva una, en su cabecera). */
    const qr = envios().find(e => e.startsWith('{"type":"image"'))!;
    expect(qr).toContain('cobros/');
    expect(qr).toContain('Bs 280');
    expect(qr).toContain('Banco Sintético, a nombre de Clínica Sintética SRL');

    const comprobanteId = await mandarComprobante(id);
    const pago = await pagoAbierto(id);
    expect(pago).toMatchObject({ estado: 'COMPROBANTE_ENVIADO', comprobanteMensajeId: comprobanteId });
    expect((await prisma.conversacion.findUniqueOrThrow({ where: { id } })).atencionMotivo).toBe('COMPROBANTE_PAGO');
    await esperar(async () => (await textosAutomaticos(id)).some(t => t.startsWith('✅ Recibimos tu comprobante')));

    const confirmado = await http(`/conversaciones/${id}/pagos/${pago.id}/confirmar`, 'POST');
    expect(confirmado.status).toBe(201);
    expect(confirmado.body).toMatchObject({ estado: 'CONFIRMADO', monto: 280 });
    const venta = await prisma.venta.findFirstOrThrow({ where: { pagoPromocion: { id: pago.id } }, include: { lead: true } });
    expect(venta).toMatchObject({ estado: 'GANADA', metodoPago: 'QR', agenteId: usuarios.agente.id });
    expect(venta.monto.toNumber()).toBe(280);
    expect(venta.lead?.promocionId).toBe(promocionId);
    expect(venta.comprobanteKey).toMatch(new RegExp(`^comprobantes/${usuarios.agente.id}/pago-${pago.id}`));
    expect(almacen.has(venta.comprobanteKey!)).toBe(true);
    expect((await prisma.conversacion.findUniqueOrThrow({ where: { id } })).atencionSolicitadaEn).toBeNull();
    expect(await prisma.mensaje.findFirst({ where: { conversacionId: id, automatico: false, contenido: { startsWith: '✅ Confirmamos tu pago de Bs 280' } } })).not.toBeNull();

    /* Doble clic: ni otra venta ni otro mensaje. */
    expect((await http(`/conversaciones/${id}/pagos/${pago.id}/confirmar`, 'POST')).status).toBe(201);
    expect(await prisma.venta.count({ where: { pagoPromocion: { id: pago.id } } })).toBe(1);
    expect(await prisma.mensaje.count({ where: { conversacionId: id, contenido: { startsWith: '✅ Confirmamos tu pago' } } })).toBe(1);
  });

  it('pedir otro comprobante vuelve a esperar uno, con el motivo; la foto siguiente lo reemplaza', async () => {
    await configurarCobro();
    const { chat: id, tarjeta } = await llegarPorLaLanding();
    await pagar(id, tarjeta);
    await mandarComprobante(id);
    const pago = await pagoAbierto(id);
    const r = await http(`/conversaciones/${id}/pagos/${pago.id}/pedir-otro`, 'POST', usuarios.agente.token, { motivo: 'el monto no coincide' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ estado: 'PENDIENTE', motivoRechazo: 'el monto no coincide' });
    expect(await prisma.mensaje.findFirst({ where: { conversacionId: id, contenido: { contains: 'el monto no coincide' } } })).not.toBeNull();
    const nuevo = await mandarComprobante(id);
    expect(await pagoAbierto(id)).toMatchObject({ estado: 'COMPROBANTE_ENVIADO', comprobanteMensajeId: nuevo });
    /* El segundo comprobante también recibe su acuse. */
    await esperar(async () => (await textosAutomaticos(id)).filter(t => t.startsWith('✅ Recibimos tu comprobante')).length === 2);
  });

  it('volver a tocar «Pagar ahora» mantiene el monto congelado; con el comprobante en revisión no se manda otro QR', async () => {
    await configurarCobro();
    const { chat: id, tarjeta } = await llegarPorLaLanding();
    await pagar(id, tarjeta);
    await prisma.promocion.update({ where: { id: promocionId }, data: { precioPromocional: 300 } });
    /* Inmediatamente, el mismo QR no se repite; horas después, sí (con el monto de entonces). */
    await webhook([toque(tarjeta, 'PAGAR_PROMOCION')]);
    await reposo();
    expect(await prisma.mensaje.count({ where: { conversacionId: id, automatico: true, tipo: 'IMAGEN' } })).toBe(1);
    await prisma.mensaje.updateMany({ where: { conversacionId: id, automatico: true, tipo: 'IMAGEN' }, data: { createdAt: new Date(Date.now() - 86_400_000) } });
    await webhook([toque(tarjeta, 'PAGAR_PROMOCION')]);
    await esperar(async () => (await prisma.mensaje.count({ where: { conversacionId: id, automatico: true, tipo: 'IMAGEN', whatsappMsgId: { not: null } } })) === 2);
    expect(await prisma.pagoPromocion.count({ where: { conversacionId: id } })).toBe(1);
    expect((await pagoAbierto(id)).monto.toNumber()).toBe(280);
    expect(envios().filter(e => e.startsWith('{"type":"image"')).every(e => e.includes('Bs 280') && !e.includes('Bs 300'))).toBe(true);

    await mandarComprobante(id);
    const imagenes = envios().filter(e => e.startsWith('{"type":"image"')).length;
    await webhook([toque(tarjeta, 'PAGAR_PROMOCION')]);
    await reposo();
    expect(envios().filter(e => e.startsWith('{"type":"image"'))).toHaveLength(imagenes);
    expect(await pagoAbierto(id)).toMatchObject({ estado: 'COMPROBANTE_ENVIADO' });
  });

  it('si la venta no nace, el pago vuelve a «por verificar» y se puede confirmar después', async () => {
    await configurarCobro();
    const { chat: id, tarjeta } = await llegarPorLaLanding();
    await pagar(id, tarjeta);
    const comprobanteId = await mandarComprobante(id);
    const clave = (await prisma.mensaje.findUniqueOrThrow({ where: { id: comprobanteId } })).mediaKey!;
    const guardado = almacen.get(clave)!;
    almacen.delete(clave);
    const pago = await pagoAbierto(id);
    expect((await http(`/conversaciones/${id}/pagos/${pago.id}/confirmar`, 'POST')).status).toBeGreaterThanOrEqual(400);
    expect(await pagoAbierto(id)).toMatchObject({ estado: 'COMPROBANTE_ENVIADO', ventaId: null, cerradoPorId: null });
    expect(await prisma.venta.count({ where: { cliente: { telefono } } })).toBe(0);
    almacen.set(clave, guardado);
    expect((await http(`/conversaciones/${id}/pagos/${pago.id}/confirmar`, 'POST')).body).toMatchObject({ estado: 'CONFIRMADO' });
    expect(await prisma.venta.count({ where: { cliente: { telefono } } })).toBe(1);
  });

  it('retomar el mismo QR después de 72 h vuelve a admitir el comprobante y conserva el monto', async () => {
    await configurarCobro();
    const { chat: id, tarjeta } = await llegarPorLaLanding();
    await pagar(id, tarjeta);
    const pago = await pagoAbierto(id);
    await prisma.$executeRaw`UPDATE "PagoPromocion" SET "updatedAt" = now() - interval '73 hours' WHERE id = ${pago.id}`;
    await prisma.promocion.update({ where: { id: promocionId }, data: { precioPromocional: 300 } });
    const inicio = await app.get(PromocionesChatService).iniciar(id, ventas, promocionId);
    expect(inicio).toMatchObject({ pagoId: pago.id, texto: expect.stringContaining('Bs 280') });
    const comprobanteMensajeId = await mandarComprobante(id);
    expect(await pagoAbierto(id)).toMatchObject({ id: pago.id, estado: 'COMPROBANTE_ENVIADO', comprobanteMensajeId });
    expect(await prisma.pagoPromocion.count({ where: { conversacionId: id } })).toBe(1);
  });

  it('la venta se registra sin ventana de WhatsApp, pero la respuesta advierte que el aviso no salió', async () => {
    await configurarCobro();
    const { chat: id, tarjeta } = await llegarPorLaLanding();
    await pagar(id, tarjeta); await mandarComprobante(id);
    await reposo();
    await prisma.mensaje.updateMany({ where: { conversacionId: id, direccion: 'ENTRANTE' }, data: { createdAt: new Date(Date.now() - 25 * 3_600_000) } });
    const pago = await pagoAbierto(id);
    const r = await http(`/conversaciones/${id}/pagos/${pago.id}/confirmar`, 'POST');
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ estado: 'CONFIRMADO', avisoPaciente: 'NO_ENVIADO', ventaId: expect.any(String) });
    expect(await prisma.venta.count({ where: { cliente: { telefono } } })).toBe(1);
    expect(await prisma.mensaje.count({ where: { conversacionId: id, contenido: { startsWith: '✅ Confirmamos tu pago' } } })).toBe(0);
  });

  it('una confirmación interrumpida sigue visible y no admite otro QR; quien la inició puede completarla', async () => {
    await configurarCobro();
    const { chat: id, tarjeta } = await llegarPorLaLanding();
    await pagar(id, tarjeta); await mandarComprobante(id);
    const pago = await pagoAbierto(id);
    // Estado persistido entre reclamar y enlazar la venta (por ejemplo, un reinicio).
    await prisma.pagoPromocion.update({ where: { id: pago.id }, data: {
      estado: 'CONFIRMADO', cerradoPorId: usuarios.agente.id, cerradoEn: new Date(Date.now() - 15 * 86_400_000),
    } });
    const detalle = await http(`/conversaciones/${id}`);
    expect(detalle.body.pago).toMatchObject({ id: pago.id, registroPendiente: true, ventaId: null });
    expect(await app.get(PromocionesChatService).iniciar(id, ventas, promocionId)).toBe('EN_VERIFICACION');
    expect(await prisma.pagoPromocion.count({ where: { conversacionId: id } })).toBe(1);
    expect((await http(`/conversaciones/${id}/pagos/${pago.id}/confirmar`, 'POST', usuarios.admin.token)).status).toBe(409);
    const r = await http(`/conversaciones/${id}/pagos/${pago.id}/confirmar`, 'POST');
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ registroPendiente: false, ventaId: expect.any(String) });
    expect((await http(`/conversaciones/${id}/pagos/${pago.id}/confirmar`, 'POST')).status).toBe(201);
    expect(await prisma.venta.count({ where: { cliente: { telefono } } })).toBe(1);
  });

  it('una foto días después del QR ya no cuenta como comprobante', async () => {
    await configurarCobro();
    const { chat: id, tarjeta } = await llegarPorLaLanding();
    await pagar(id, tarjeta);
    const pago = await pagoAbierto(id);
    await prisma.$executeRaw`UPDATE "PagoPromocion" SET "updatedAt" = now() - interval '73 hours' WHERE id = ${pago.id}`;
    await webhook([foto()]);
    await reposo();
    expect(await pagoAbierto(id)).toMatchObject({ estado: 'PENDIENTE', comprobanteMensajeId: null });
  });

  it('la promoción va al lead abierto más reciente; si ese ya vino por un anuncio, no se toca', async () => {
    await llegarPorLaLanding();
    const lead = await prisma.lead.findFirstOrThrow({ where: { cliente: { telefono } }, orderBy: { createdAt: 'desc' } });
    expect(lead.promocionId).toBe(promocionId);
    const leads = app.get(LeadsService);
    expect(await leads.atribuirPromocion(lead.clienteId, promocionId)).toBe(false);
  });

  it('el comprobante que todavía se descarga no se puede confirmar; anular cierra sin venta', async () => {
    await configurarCobro();
    const { chat: id, tarjeta } = await llegarPorLaLanding();
    await pagar(id, tarjeta);
    expect((await webhook([foto()])).status).toBe(200);
    const pago = await pagoAbierto(id);
    const r = await http(`/conversaciones/${id}/pagos/${pago.id}/confirmar`, 'POST');
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toContain('se está descargando');
    expect((await http(`/conversaciones/${id}/pagos/${pago.id}/anular`, 'POST')).body).toMatchObject({ estado: 'ANULADO' });
    expect(await prisma.venta.count({ where: { cliente: { telefono } } })).toBe(0);
  });

  it('una foto sin pago pendiente es solo una foto', async () => {
    await configurarCobro();
    const { chat: id } = await llegarPorLaLanding();
    await webhook([foto()]);
    await reposo();
    expect(await prisma.pagoPromocion.count({ where: { conversacionId: id } })).toBe(0);
    expect((await prisma.conversacion.findUniqueOrThrow({ where: { id } })).atencionMotivo).not.toBe('COMPROBANTE_PAGO');
  });
});

describe('cuando no se puede cobrar', () => {
  it('sin QR en la línea la tarjeta no ofrece pagar', async () => {
    await llegarPorLaLanding();
    const tarjeta = envios().find(e => e.includes('"type":"button"'))!;
    expect(tarjeta).not.toContain('PAGAR_PROMOCION');
    expect(tarjeta).toContain('TALK_TO_HUMAN');
  });

  it('si la promoción venció entre la tarjeta y el toque, no se manda QR: lo ve una persona', async () => {
    await configurarCobro();
    const { chat: id, tarjeta } = await llegarPorLaLanding();
    await prisma.promocion.update({ where: { id: promocionId }, data: { estado: 'PAUSADA' } });
    await webhook([toque(tarjeta, 'PAGAR_PROMOCION')]);
    await esperar(async () => (await prisma.conversacion.findUniqueOrThrow({ where: { id } })).atencionMotivo === 'REVISION');
    expect(await prisma.pagoPromocion.count({ where: { conversacionId: id } })).toBe(0);
  });

  it('«Pagar ahora» en una tarjeta caducada no manda QR: lo ve una persona', async () => {
    await configurarCobro();
    const { chat: id, tarjeta } = await llegarPorLaLanding();
    await prisma.interaccionMensaje.updateMany({ where: { mensaje: { whatsappMsgId: tarjeta } }, data: { venceEn: new Date(Date.now() - 60_000) } });
    await webhook([toque(tarjeta, 'PAGAR_PROMOCION')]);
    await esperar(async () => (await prisma.conversacion.findUniqueOrThrow({ where: { id } })).atencionMotivo === 'REVISION');
    expect(await prisma.pagoPromocion.count({ where: { conversacionId: id } })).toBe(0);
  });

  it('el código de una promoción que ya no está visible no responde nada', async () => {
    await prisma.promocion.update({ where: { id: promocionId }, data: { estado: 'PAUSADA' } });
    await webhook([texto(`Hola (${CODIGO})`)]);
    await reposo();
    expect(envios().some(e => e.includes('"type":"button"'))).toBe(false);
  });
});

describe('el menú de WhatsApp lee las promociones del CRM', () => {
  it('la opción «Promociones» lista las publicadas y elegir una manda su tarjeta', async () => {
    await configurarCobro();
    const guardado = await http(`/menu-atencion/${ventas}`, 'PUT', usuarios.admin.token, {
      activo: true, saludo: 'Hola, ¿qué te interesa?',
      opciones: [{ tipo: 'PROMOCIONES', titulo: 'Ver promociones', respuesta: 'Promociones vigentes:' }, { tipo: 'PERSONA', titulo: 'Hablar con asesora' }],
    });
    expect(guardado.status).toBe(200);
    await webhook([texto('Hola')]);
    const id = (await chat()).id;
    await esperar(async () => (await ofertas(id)).length === 1);
    await webhook([toque((await ofertas(id))[0].whatsappMsgId!, 'VIEW_PROMOTIONS')]);
    await esperar(async () => (await ofertas(id)).length === 2);
    const lista = (await ofertas(id))[1];
    await webhook([toque(lista.whatsappMsgId!, `PROMO_${promocionId}`, 'list_reply')]);
    await esperar(async () => (await ofertas(id)).length === 3);
    expect(envios().filter(e => e.includes('PAGAR_PROMOCION'))).toHaveLength(1);
  });

  it('si las promociones se retiran entre el menú y el toque, lo ve una persona', async () => {
    await http(`/menu-atencion/${ventas}`, 'PUT', usuarios.admin.token, {
      activo: true, saludo: 'Hola, ¿qué te interesa?',
      opciones: [{ tipo: 'PROMOCIONES', titulo: 'Ver promociones', respuesta: 'Promociones vigentes:' }, { tipo: 'PERSONA', titulo: 'Hablar con asesora' }],
    });
    await webhook([texto('Hola')]);
    const id = (await chat()).id;
    await esperar(async () => (await ofertas(id)).length === 1);
    await prisma.promocion.update({ where: { id: promocionId }, data: { estado: 'PAUSADA' } });
    await webhook([toque((await ofertas(id))[0].whatsappMsgId!, 'VIEW_PROMOTIONS')]);
    await esperar(async () => (await prisma.conversacion.findUniqueOrThrow({ where: { id } })).atencionMotivo === 'REVISION');
    expect(await ofertas(id)).toHaveLength(1);
  });
});
