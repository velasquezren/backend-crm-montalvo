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
import { MenuAtencionService } from '../menu-atencion/menu-atencion.service';
import { CobrosController } from '../cobros/cobros.controller';
import { CobrosService } from '../cobros/cobros.service';
import { PromocionesService } from '../promociones/promociones.service';
import { VentasService } from '../ventas/ventas.service';
import { AgendaReservasService } from '../agenda/agenda-reservas.service';
import { AgendaService } from '../agenda/agenda.service';
import { AsistenteController } from '../asistente/asistente.controller';
import { AsistenteLineasService } from '../asistente/asistente-lineas.service';
import { ConversacionAsistente } from '../asistente/conversacion-asistente';
import { HerramientasAsistenteService } from '../asistente/herramientas';
import { ImagenHorarioService } from '../asistente/imagen-horario.service';
import {
  Clasificacion, ClasificadorMensajes, DatosComprobante, DeclaracionHerramienta, LectorComprobantes, ModeloConversacional, RespuestaModelo, TurnoModelo,
} from '../asistente/modelo.port';
import { PRESENTACION } from '../asistente/texto-whatsapp';
import { ConfiguracionIA } from '../asistente/vertex/proveedor-vertex';
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
import { AsistenteChatController } from './asistente-chat.controller';
import { AsistenteChatService, TEXTO_DERIVACION } from './asistente-chat.service';
import { LecturaComprobantesService } from './lectura-comprobantes.service';
import { WhatsappWebhookController } from './webhooks/whatsapp-webhook.controller';

/*
 * El asistente de IA en un chat de Ventas, de punta a punta (docs/asistente-ia.md):
 * webhook firmado, Postgres real, HTTP con los guards reales. Lo único falso es
 * lo que está fuera de esta máquina: Meta, R2 y GEMINI — un modelo guionado que
 * contesta lo que cada prueba le dicta. Las reglas que se prueban no dependen de
 * lo que el modelo diga, sino de lo que el CRM hace con eso.
 */

// URL deliberadamente fija; nunca usar DATABASE_URL ni cargar .env en esta suite.
const prisma = new PrismaService('postgresql://crm_app@127.0.0.1:5433/crm_test');
const secretoSintetico = 'firma-webhook-sintetica-asistente';
const transporte = { enviar: jest.fn<Promise<ResultadoEnvio>, unknown[]>(), listarPlantillas: jest.fn() };
const ACUSE = 'Acuse sintético fuera de horario.';
const config = new ConfigService({
  META_APP_SECRET: secretoSintetico,
  AUTORESPUESTA_TEXTO: ACUSE,
  /* Siempre «fuera de horario» salvo un minuto de los domingos: el acuse saldría. */
  AUTORESPUESTA_HORARIO: 'D:03:00-03:01',
  UBICACION_AUTOMATICA: 'off',
  /* La bandera ENCENDIDA: es el camino que verá la clínica. */
  ASISTENTE_IA: 'on',
  GOOGLE_CLOUD_PROJECT: 'proyecto-sintetico',
  ASISTENTE_ESPERA_MS: '0',
});

const almacen = new Map<string, { bytes: Uint8Array; mime: string }>();
const r2 = {
  habilitado: true,
  async subir(clave: string, cuerpo: ArrayBuffer, mime: string) { almacen.set(clave, { bytes: new Uint8Array(cuerpo), mime }); },
  async leer(clave: string) {
    const o = almacen.get(clave);
    return o ? { cuerpo: new Blob([Uint8Array.from(o.bytes)]).stream(), tipo: o.mime, bytes: o.bytes.byteLength } : null;
  },
  async eliminar(clave: string) { almacen.delete(clave); },
  async urlFirmada(clave: string) { return `https://r2.invalid/${clave}?firmada`; },
};

/* ── Gemini, guionado ─────────────────────────────────────────────────── */
const USO = { tokensEntrada: 100, tokensSalida: 20 };
class ModeloGuionado extends ModeloConversacional {
  readonly nombre = 'gemini-guionado';
  guion: (RespuestaModelo | Error)[] = [];
  readonly vistas: { historial: readonly TurnoModelo[]; herramientas: readonly DeclaracionHerramienta[] }[] = [];
  responder(e: { historial: readonly TurnoModelo[]; herramientas: readonly DeclaracionHerramienta[] }): Promise<RespuestaModelo> {
    this.vistas.push({ historial: [...e.historial], herramientas: e.herramientas });
    const paso = this.guion.shift() ?? { tipo: 'texto', texto: 'Respuesta por defecto.', uso: USO };
    return paso instanceof Error ? Promise.reject(paso) : Promise.resolve(paso);
  }
}
class ClasificadorGuionado extends ClasificadorMensajes {
  readonly nombre = 'clasificador-guionado';
  siguiente: Pick<Clasificacion, 'categoria' | 'confianza'> | Error = { categoria: 'VENTAS', confianza: 'ALTA' };
  clasificar(): Promise<Clasificacion> {
    const c = this.siguiente;
    return c instanceof Error ? Promise.reject(c) : Promise.resolve({ ...c, uso: { tokensEntrada: 5, tokensSalida: 1 } });
  }
}
class LectorGuionado extends LectorComprobantes {
  readonly nombre = 'lector-guionado';
  datos: DatosComprobante = {
    esComprobante: true, monto: 280, moneda: 'Bs', fechaHora: null, referencia: 'OP-778899', banco: 'BNB', destinatario: 'Clínica Sintética SRL', ordenante: 'Ana',
  };
  leer() { return Promise.resolve({ datos: this.datos, uso: USO }); }
}
const modelo = new ModeloGuionado();
const clasificador = new ClasificadorGuionado();
const lector = new LectorGuionado();
const agenda = {
  medico: async () => ({
    medico: { id: '7', especialidadId: 'e1', nombre: 'Dra. Sintética', modalidad: 'ONLINE', precio: { importeCentavos: 25000, moneda: 'BOB' }, horarioInformativo: 'Martes: entre 10:00 y 12:00', fotoUrl: null },
    especialidad: { id: 'e1', nombre: 'Ginecología' },
  }),
};
const imagenes = {
  de: jest.fn(async () => ({ key: 'asistente/horarios/7-abc.png', mime: 'image/png' as const, nombre: 'Horario Dra. Sintética.png' })),
  dibujar: jest.fn(async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
};

@Module({
  imports: [JwtModule.register({ secret: 'jwt-sintetico-asistente', signOptions: { expiresIn: '15m' } })],
  controllers: [ConversacionesController, AsistenteChatController, WhatsappWebhookController, CobrosController, AsistenteController],
  providers: [
    { provide: PrismaService, useValue: prisma }, { provide: ConfigService, useValue: config },
    AuditService, AuthService, UsuariosService, ClientesService, CategoriaPacienteService, ServiciosService, TipoCambioService,
    LineasWhatsappService, LeadsService, PrimerContactoService, MemoriaAgenteService, ConversacionesService, EnvioPlantillasService,
    AtencionHumanaService, ConversacionesGateway, IngestaWhatsappService, MenuAtencionService, AcuseAutomaticoService,
    DespachadorSalienteService, ReintentoSalienteService, CierreInactividadService, MetaSignatureGuard,
    PromocionesChatService, CobrosService, PromocionesService, VentasService, AvisoLandingService,
    ConfiguracionIA, AsistenteLineasService, ConversacionAsistente, HerramientasAsistenteService, AsistenteChatService, LecturaComprobantesService,
    { provide: ModeloConversacional, useValue: modelo },
    { provide: ClasificadorMensajes, useValue: clasificador },
    { provide: LectorComprobantes, useValue: lector },
    { provide: ImagenHorarioService, useValue: imagenes },
    { provide: AgendaService, useValue: agenda },
    { provide: AgendaReservasService, useValue: { reservar: jest.fn() } },
    { provide: WhatsappCloudService, useValue: transporte },
    { provide: R2Service, useValue: r2 },
    { provide: PushService, useValue: { enviarAUsuario: async () => undefined } },
    { provide: AlertasWhatsappService, useValue: { procesar: async () => undefined } },
    { provide: MediaEntranteService, useValue: { despertar: () => undefined } },
    { provide: APP_GUARD, useClass: JwtAuthGuard }, { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
class ModuloAsistenteTest {}

const PREFIJO_TEL = '+591700031';
const telefono = `${PREFIJO_TEL}01`;
const PHONE_VENTAS = 'meta-asistente-ventas';
const CODIGO = 'PRM-4SVTA';
const CRITERIO = 'Todo lo que sea embarazo con molestias, sangrados, dolores, medicamentos, resultados o cuidados después de un procedimiento.';
const envOriginal = { flag: process.env['WHATSAPP_INTERACCIONES'], lineas: process.env['WHATSAPP_INTERACCIONES_LINEAS'], key: process.env['WHATSAPP_INTERACCIONES_KEY'], url: process.env['CRM_URL_PUBLICA'] };

let app: INestApplication;
let base: string;
let ventas: string;
let promocionId: string;
const usuarios: Record<'admin' | 'agente', { id: string; token: string }> = {} as never;

async function http(ruta: string, metodo = 'GET', bearer = usuarios.agente.token, cuerpo?: unknown) {
  const r = await fetch(base + ruta, { method: metodo, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` }, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
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
const toque = (contexto: string, opcion: string) =>
  ({ id: `wamid.in.${randomUUID()}`, from: telefono.slice(1), type: 'interactive', timestamp: ahoraMeta(), context: { id: contexto }, interactive: { type: 'button_reply', button_reply: { id: opcion, title: 'x' } } });

async function esperar(condicion: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 150; i++) { if (await condicion()) return; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('La condición no se cumplió a tiempo');
}
const reposo = () => new Promise(r => setTimeout(r, 300));
const chat = () => prisma.conversacion.findFirstOrThrow({ where: { lineaId: ventas, cliente: { telefono } } });
const turnos = (conversacionId: string) => prisma.turnoAsistente.findMany({ where: { conversacionId }, orderBy: { createdAt: 'asc' } });
/** Escribe y espera a que el asistente registre su turno. */
async function escribir(cuerpo: string, turnosEsperados = 1) {
  expect((await webhook([texto(cuerpo)])).status).toBe(200);
  const c = await chat();
  await esperar(async () => (await turnos(c.id)).length >= turnosEsperados);
  await reposo();
  return c.id;
}
const salientes = (conversacionId: string) => prisma.mensaje.findMany({ where: { conversacionId, direccion: 'SALIENTE' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
const dice = (t: string): RespuestaModelo => ({ tipo: 'texto', texto: t, uso: USO });
const pide = (nombre: string, argumentos: Record<string, unknown> = {}): RespuestaModelo => ({
  tipo: 'herramientas', llamadas: [{ nombre, argumentos }], crudo: { role: 'model', parts: [{ functionCall: { name: nombre, args: argumentos }, thoughtSignature: 'firma' }] }, uso: USO,
});

async function configurarAsistente(modo: 'SUGERIR' | 'RESPONDER', leerComprobantes = false) {
  const r = await http(`/asistente/lineas/${ventas}`, 'PUT', usuarios.admin.token, { modo, conocimiento: 'La consulta incluye ecografía.', criterioDerivacion: CRITERIO, leerComprobantes });
  expect(r.status).toBe(200);
}
async function configurarCobro() {
  const form = new FormData();
  form.append('archivo', new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 2, 0x58, 0, 0, 2, 0x58, 8, 2, 0, 0, 0, 0, 0, 0, 0])], { type: 'image/png' }), 'qr.png');
  expect((await fetch(`${base}/cobros/${ventas}/qr`, { method: 'PUT', headers: { Authorization: `Bearer ${usuarios.admin.token}` }, body: form })).status).toBe(200);
  expect((await http(`/cobros/${ventas}`, 'PUT', usuarios.admin.token, { activo: true, banco: 'Banco Sintético', titular: 'Clínica Sintética SRL' })).status).toBe(200);
}

async function limpiar() {
  await prisma.pagoPromocion.deleteMany({ where: { linea: { nombre: { startsWith: 'ASIST-' } } } });
  await prisma.venta.deleteMany({ where: { cliente: { telefono: { startsWith: PREFIJO_TEL } } } });
  await prisma.cliente.deleteMany({ where: { telefono: { startsWith: PREFIJO_TEL } } });
  const ids = (await prisma.usuario.findMany({ where: { email: { endsWith: '@asistente.test' } }, select: { id: true } })).map(u => u.id);
  await prisma.auditLog.deleteMany({ where: { OR: [{ usuarioId: { in: ids } }, { entidad: { in: ['PagoPromocion', 'Conversacion', 'AsistenteLinea', 'SugerenciaAsistente'] } }] } });
  await prisma.promocion.deleteMany({ where: { codigo: CODIGO } });
  await prisma.lineaWhatsapp.deleteMany({ where: { nombre: { startsWith: 'ASIST-' } } });
  await prisma.usuario.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
  process.env['WHATSAPP_INTERACCIONES'] = 'on';
  process.env['WHATSAPP_INTERACCIONES_LINEAS'] = 'todas';
  process.env['WHATSAPP_INTERACCIONES_KEY'] = Buffer.alloc(32, 21).toString('base64');
  process.env['CRM_URL_PUBLICA'] = 'https://crm.sintetico.test';
  const nueva = await NestFactory.create(ModuloAsistenteTest, { rawBody: true, logger: false, abortOnError: false });
  nueva.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await nueva.listen(0, '127.0.0.1');
  app = nueva;
  base = await app.getUrl();
}, 30_000);

beforeEach(async () => {
  await limpiar();
  almacen.clear();
  modelo.guion = [];
  modelo.vistas.length = 0;
  clasificador.siguiente = { categoria: 'VENTAS', confianza: 'ALTA' };
  imagenes.de.mockClear();
  transporte.enviar.mockReset().mockImplementation(async () => ({ estado: 'ENVIADO', metaMsgId: `wamid.out.${randomUUID()}` }));
  ventas = (await prisma.lineaWhatsapp.create({ data: { nombre: 'ASIST-ventas', telefono: '+59170003191', phoneNumberId: PHONE_VENTAS, tokenEnv: 'TOKEN_INEXISTENTE_ASIST', comercial: true, activa: true } })).id;
  for (const [clave, rol, lineas] of [['admin', 'SUPER_ADMIN', []], ['agente', 'AGENTE', [ventas]]] as const) {
    const u = await prisma.usuario.create({ data: {
      nombre: `Persona ${clave}`, email: `${clave}@asistente.test`, passwordHash: await bcrypt.hash('sintetico', 4), rol, activo: true,
      lineasWhatsapp: { create: lineas.map(lineaId => ({ lineaId })) },
    } });
    usuarios[clave] = { id: u.id, token: (await app.get(AuthService).login({ email: u.email, password: 'sintetico' })).access_token };
  }
  const hoy = new Date(); hoy.setUTCHours(0, 0, 0, 0);
  promocionId = (await prisma.promocion.create({ data: {
    codigo: CODIGO, slug: `control-${randomUUID().slice(0, 8)}`, titulo: 'Control prenatal', resumen: 'Consulta y ecografía.',
    condiciones: 'Lunes a viernes.', precioRegular: 350, precioPromocional: 280, estado: 'PUBLICADA', publicadaEn: new Date(),
    vigenteDesde: new Date(hoy.getTime() - 86_400_000), vigenteHasta: new Date(hoy.getTime() + 30 * 86_400_000),
    imagenes: { create: { formato: 'CUADRADO', clave: 'promociones/x/banner.png', mime: 'image/png', ancho: 1080, alto: 1080, bytes: 33, textoAlternativo: 'Banner' } },
  } })).id;
});

afterAll(async () => {
  await limpiar(); await app?.close(); await prisma.$disconnect();
  for (const [nombre, valor] of [['WHATSAPP_INTERACCIONES', envOriginal.flag], ['WHATSAPP_INTERACCIONES_LINEAS', envOriginal.lineas], ['WHATSAPP_INTERACCIONES_KEY', envOriginal.key], ['CRM_URL_PUBLICA', envOriginal.url]] as const) {
    if (valor === undefined) delete process.env[nombre]; else process.env[nombre] = valor;
  }
});

describe('la configuración por línea', () => {
  it('solo SUPER_ADMIN; RESPONDER sin el criterio de la clínica es 400; queda auditado', async () => {
    expect((await http(`/asistente/lineas/${ventas}`, 'GET', usuarios.agente.token)).status).toBe(403);
    const sinCriterio = await http(`/asistente/lineas/${ventas}`, 'PUT', usuarios.admin.token, { modo: 'RESPONDER', conocimiento: '', criterioDerivacion: '', leerComprobantes: false });
    expect(sinCriterio.status).toBe(400);
    await configurarAsistente('RESPONDER');
    const r = await http(`/asistente/lineas/${ventas}`, 'GET', usuarios.admin.token);
    expect(r.body).toMatchObject({ configuracion: { modo: 'RESPONDER' }, proveedor: { listo: true, modelo: 'gemini-3.5-flash' } });
    expect(await prisma.auditLog.count({ where: { entidad: 'AsistenteLinea', entidadId: ventas, accion: 'ASISTENTE_CONFIGURADO' } })).toBe(1);
  });

  it('«Probar conexión»: solo SUPER_ADMIN, y recorre filtro, herramienta y comprobante con datos sintéticos', async () => {
    expect((await http('/asistente/probar', 'POST', usuarios.agente.token)).status).toBe(403);
    lector.datos = { ...lector.datos, monto: 280.5 };
    modelo.guion = [pide('hora_de_la_clinica'), dice('Son las 15:40.')];
    const r = await http('/asistente/probar', 'POST', usuarios.admin.token);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true });
    expect((r.body['pasos'] as { paso: string }[]).map(p => p.paso)).toEqual(['CONFIGURACION', 'FILTRO', 'CONVERSACION', 'COMPROBANTE']);
    lector.datos = { ...lector.datos, monto: 280 };
  });

  it('APAGADO, la línea se comporta como siempre: acuse y ningún turno', async () => {
    expect((await webhook([texto('hola, precio del control')])).status).toBe(200);
    const c = await chat();
    await esperar(async () => (await salientes(c.id)).some(m => m.contenido === ACUSE));
    expect(await turnos(c.id)).toHaveLength(0);
    expect(modelo.vistas).toHaveLength(0);
  });
});

describe('RESPONDER: contesta lo comercial', () => {
  beforeEach(() => configurarAsistente('RESPONDER'));

  it('contesta con datos de una herramienta, se presenta, NO manda el acuse y la conversación sigue en «Sin responder»', async () => {
    modelo.guion = [pide('listar_promociones'), dice('El **Control prenatal** está a Bs 280 hasta fin de mes.')];
    const id = await escribir('hola, cuánto cuesta el control prenatal?');
    const [respuesta, ...resto] = await salientes(id);
    expect(resto).toHaveLength(0);
    expect(respuesta).toMatchObject({ automatico: true, asistente: true });
    expect(respuesta.contenido).toBe(`${PRESENTACION}\n\nEl *Control prenatal* está a Bs 280 hasta fin de mes.`);
    expect(JSON.stringify(transporte.enviar.mock.calls)).toContain('Control prenatal');
    /* Lo que el modelo vio de la herramienta salió de Promociones, no de él. */
    expect(JSON.stringify(modelo.vistas[1].historial)).toContain('"precioBs":280');
    expect((await prisma.conversacion.findUniqueOrThrow({ where: { id } })).esperandoRespuesta).toBe(true);
    expect(await turnos(id)).toMatchObject([{ resultado: 'RESPONDIO', categoria: 'VENTAS', herramientas: [{ nombre: 'listar_promociones', ok: true }], tokensEntrada: 205 }]);
  });

  it('se presenta una sola vez por día', async () => {
    modelo.guion = [dice('¡Hola! ¿En qué te ayudo?'), dice('Claro, te cuento.')];
    const id = await escribir('hola');
    await escribir('quiero saber de promociones', 2);
    const textos = (await salientes(id)).map(m => m.contenido);
    expect(textos.filter(t => t.startsWith(PRESENTACION))).toHaveLength(1);
  });

  it('enviar_promocion manda la TARJETA de verdad: «Pagar ahora» de esa tarjeta abre el pago con el QR', async () => {
    await configurarCobro();
    modelo.guion = [pide('enviar_promocion', { promocionId }), dice('Te envío la promoción 👇')];
    const id = await escribir('me interesa el control prenatal, cómo pago?');
    const tarjeta = await prisma.mensaje.findFirstOrThrow({ where: { conversacionId: id, automatico: true, interaccion: { isNot: null } } });
    expect(tarjeta).toMatchObject({ asistente: true });
    await esperar(async () => !!(await prisma.mensaje.findUniqueOrThrow({ where: { id: tarjeta.id } })).whatsappMsgId);
    const wamid = (await prisma.mensaje.findUniqueOrThrow({ where: { id: tarjeta.id } })).whatsappMsgId!;
    expect((await webhook([toque(wamid, 'PAGAR_PROMOCION')])).status).toBe(200);
    await esperar(async () => !!(await prisma.pagoPromocion.findFirst({ where: { conversacionId: id, promocionId, estado: 'PENDIENTE' } })));
  });

  it('enviar_horario manda la imagen con el horario en el pie', async () => {
    modelo.guion = [pide('enviar_horario', { medicoId: '7' }), dice('Te paso su horario.')];
    const id = await escribir('qué días atiende la dra sintética?');
    const imagen = await prisma.mensaje.findFirstOrThrow({ where: { conversacionId: id, tipo: 'IMAGEN' } });
    expect(imagen).toMatchObject({ asistente: true, mediaKey: 'asistente/horarios/7-abc.png', contenido: '🗓️ Horario de Dra. Sintética\nMartes: entre 10:00 y 12:00' });
  });
});

describe('RESPONDER: lo que no le toca, pasa a una persona', () => {
  beforeEach(() => configurarAsistente('RESPONDER'));

  it('una consulta médica no llega al modelo: solicitud DERIVADA_ASISTENTE, pausa y aviso fijo', async () => {
    clasificador.siguiente = { categoria: 'MEDICO', confianza: 'ALTA' };
    const id = await escribir('puedo tomar ibuprofeno después del peeling?');
    expect(modelo.vistas).toHaveLength(0);
    const c = await prisma.conversacion.findUniqueOrThrow({ where: { id } });
    expect(c).toMatchObject({ atencionMotivo: 'DERIVADA_ASISTENTE' });
    expect(c.automatizacionPausadaEn).not.toBeNull();
    expect((await salientes(id)).map(m => [m.contenido, m.asistente])).toEqual([[TEXTO_DERIVACION, true]]);
    expect(await turnos(id)).toMatchObject([{ resultado: 'DERIVO', categoria: 'MEDICO' }]);
  });

  it('una posible urgencia sube como POSIBLE_URGENCIA (ALTA), no como EMERGENCIA', async () => {
    clasificador.siguiente = { categoria: 'URGENCIA', confianza: 'MEDIA' };
    const id = await escribir('estoy sangrando mucho desde ayer');
    expect((await prisma.conversacion.findUniqueOrThrow({ where: { id } })).atencionMotivo).toBe('POSIBLE_URGENCIA');
  });

  it('si el filtro falla, no se arriesga: pasa a una persona', async () => {
    clasificador.siguiente = new Error('timeout');
    const id = await escribir('hola');
    expect(modelo.vistas).toHaveLength(0);
    expect((await prisma.conversacion.findUniqueOrThrow({ where: { id } })).atencionMotivo).toBe('DERIVADA_ASISTENTE');
  });

  it('si el MODELO deriva, sale el aviso fijo y no su texto', async () => {
    modelo.guion = [pide('pasar_a_persona', { motivo: 'QUEJA', resumen: 'Molesta por la demora.' }), dice('Lamento mucho la demora, te paso con alguien.')];
    const id = await escribir('nadie me contesta hace dos días');
    expect((await salientes(id)).map(m => m.contenido)).toEqual([TEXTO_DERIVACION]);
    expect((await prisma.conversacion.findUniqueOrThrow({ where: { id } })).atencionMotivo).toBe('DERIVADA_ASISTENTE');
  });

  it('si Gemini no responde, sale el acuse de siempre: encenderlo no empeora el peor caso', async () => {
    modelo.guion = [new Error('503 UNAVAILABLE')];
    const id = await escribir('hola, precios?');
    expect((await salientes(id)).map(m => m.contenido)).toEqual([ACUSE]);
    expect(await turnos(id)).toMatchObject([{ resultado: 'FALLO' }]);
  });

  it('con la automatización pausada (pidió una persona) no escribe nada', async () => {
    modelo.guion = [dice('primera')];
    const id = await escribir('hola');
    await prisma.conversacion.update({ where: { id }, data: { automatizacionPausadaEn: new Date() } });
    await escribir('sigo esperando', 2);
    expect((await salientes(id)).filter(m => m.asistente)).toHaveLength(1);
    expect((await turnos(id)).at(-1)).toMatchObject({ resultado: 'OMITIDO' });
  });

  it('si una persona contestó hace un rato, el asistente no la interrumpe', async () => {
    modelo.guion = [dice('primera')];
    const id = await escribir('hola');
    expect((await http(`/conversaciones/${id}/mensajes`, 'POST', usuarios.agente.token, { contenido: 'Hola, soy Ana.', clientMessageId: randomUUID() })).status).toBe(201);
    await escribir('gracias Ana, y el precio?', 2);
    expect((await turnos(id)).at(-1)).toMatchObject({ resultado: 'OMITIDO', motivo: 'Una persona está atendiendo este chat.' });
  });

  it('una foto o un toque no despiertan al asistente', async () => {
    expect((await webhook([foto()])).status).toBe(200);
    await reposo();
    expect(await turnos((await chat()).id)).toHaveLength(0);
  });
});

describe('SUGERIR: prepara, no escribe', () => {
  beforeEach(() => configurarAsistente('SUGERIR'));

  it('queda una sugerencia en el detalle, con sus acciones; no sale nada del asistente', async () => {
    modelo.guion = [pide('enviar_promocion', { promocionId }), dice('Te comparto la promoción del control prenatal.')];
    const id = await escribir('promo del control?');
    expect((await salientes(id)).filter(m => m.asistente)).toHaveLength(0);
    const detalle = await http(`/conversaciones/${id}`);
    expect(detalle.body['sugerencia']).toMatchObject({ texto: 'Te comparto la promoción del control prenatal.', acciones: [{ tipo: 'PROMOCION', promocionId, titulo: 'Control prenatal' }], aviso: null });
    const sugerenciaId = (detalle.body['sugerencia'] as { id: string }).id;
    /* La agente aprueba la tarjeta: sale como automático, con su correlación de pago. */
    expect((await http(`/conversaciones/${id}/asistente/sugerencias/${sugerenciaId}/acciones/0`, 'POST')).status).toBe(201);
    expect(await prisma.mensaje.count({ where: { conversacionId: id, interaccion: { isNot: null } } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { entidad: 'SugerenciaAsistente', entidadId: sugerenciaId } })).toBe(1);
  });

  it('una sugerencia nueva reemplaza a la anterior; contestar o descartar la retira', async () => {
    modelo.guion = [dice('primera'), dice('segunda')];
    const id = await escribir('hola');
    await escribir('y el precio?', 2);
    expect(await prisma.sugerenciaAsistente.count({ where: { conversacionId: id, estado: 'PENDIENTE' } })).toBe(1);
    const s = (await http(`/conversaciones/${id}`)).body['sugerencia'] as { id: string; texto: string };
    expect(s.texto).toBe('segunda');
    expect((await http(`/conversaciones/${id}/asistente/sugerencias/${s.id}/descartar`, 'POST')).status).toBe(201);
    expect((await http(`/conversaciones/${id}`)).body['sugerencia']).toBeNull();
  });

  it('cuando una persona contesta, la sugerencia deja de mostrarse sola', async () => {
    modelo.guion = [dice('borrador')];
    const id = await escribir('hola');
    expect((await http(`/conversaciones/${id}/mensajes`, 'POST', usuarios.agente.token, { contenido: 'Hola!', clientMessageId: randomUUID() })).status).toBe(201);
    expect((await http(`/conversaciones/${id}`)).body['sugerencia']).toBeNull();
  });

  it('una consulta médica deja solo el aviso, sin borrador ni solicitud ni pausa', async () => {
    clasificador.siguiente = { categoria: 'MEDICO', confianza: 'ALTA' };
    const id = await escribir('qué crema me pongo para las manchas?');
    expect((await http(`/conversaciones/${id}`)).body['sugerencia']).toMatchObject({ texto: '', aviso: 'Consulta médica: la tiene que responder una persona.' });
    expect(await prisma.conversacion.findUniqueOrThrow({ where: { id } })).toMatchObject({ atencionMotivo: null, automatizacionPausadaEn: null });
  });

  it('otra agente sin acceso al chat no ve ni usa la sugerencia', async () => {
    modelo.guion = [dice('borrador')];
    const id = await escribir('hola');
    const s = (await http(`/conversaciones/${id}`)).body['sugerencia'] as { id: string };
    const otra = await prisma.usuario.create({ data: { nombre: 'Otra', email: 'otra@asistente.test', passwordHash: await bcrypt.hash('sintetico', 4), rol: 'AGENTE', activo: true } });
    const token = (await app.get(AuthService).login({ email: otra.email, password: 'sintetico' })).access_token;
    expect((await http(`/conversaciones/${id}/asistente/sugerencias/${s.id}/usar`, 'POST', token)).status).toBe(404);
  });
});

describe('la lectura del comprobante', () => {
  beforeEach(async () => {
    await configurarAsistente('SUGERIR', true);
    await configurarCobro();
  });

  async function pagoConComprobante(): Promise<{ id: string; pagoId: string }> {
    expect((await webhook([texto(`Me interesa (${CODIGO})`)])).status).toBe(200);
    const c = await chat();
    await esperar(async () => !!(await prisma.mensaje.findFirst({ where: { conversacionId: c.id, interaccion: { isNot: null }, whatsappMsgId: { not: null } } })));
    const tarjeta = await prisma.mensaje.findFirstOrThrow({ where: { conversacionId: c.id, interaccion: { isNot: null } } });
    expect((await webhook([toque(tarjeta.whatsappMsgId!, 'PAGAR_PROMOCION')])).status).toBe(200);
    await esperar(async () => !!(await prisma.pagoPromocion.findFirst({ where: { conversacionId: c.id, estado: 'PENDIENTE' } })));
    const m = foto();
    expect((await webhook([m])).status).toBe(200);
    await esperar(async () => !!(await prisma.pagoPromocion.findFirst({ where: { conversacionId: c.id, estado: 'COMPROBANTE_ENVIADO' } })));
    const fila = await prisma.mensaje.findUniqueOrThrow({ where: { whatsappMsgId: m.id } });
    almacen.set(`wa/${c.id}/${fila.id}`, { bytes: new Uint8Array([0xff, 0xd8, 0xff]), mime: 'image/jpeg' });
    await prisma.mensaje.update({ where: { id: fila.id }, data: { mediaKey: `wa/${c.id}/${fila.id}`, mediaMime: 'image/jpeg' } });
    return { id: c.id, pagoId: (await prisma.pagoPromocion.findFirstOrThrow({ where: { conversacionId: c.id } })).id };
  }

  it('lee monto, titular y referencia, lo compara y lo muestra en el pago; no confirma nada', async () => {
    const { id } = await pagoConComprobante();
    expect(await app.get(LecturaComprobantesService).barrer()).toBe(1);
    const pago = (await http(`/conversaciones/${id}`)).body['pago'] as Record<string, unknown>;
    expect(pago).toMatchObject({ estado: 'COMPROBANTE_ENVIADO', lectura: { resultado: 'REVISAR', datos: { monto: 280, referencia: 'OP-778899' } } });
    const verificaciones = (pago['lectura'] as { verificaciones: { campo: string; estado: string }[] }).verificaciones;
    expect(Object.fromEntries(verificaciones.map(v => [v.campo, v.estado]))).toEqual({ MONTO: 'OK', DESTINATARIO: 'OK', FECHA: 'ADVERTENCIA', REFERENCIA: 'OK' });
    /* Un segundo barrido no vuelve a leer lo ya leído. */
    expect(await app.get(LecturaComprobantesService).barrer()).toBe(0);
  });

  it('un monto distinto se marca, y un comprobante nuevo se vuelve a leer desde cero', async () => {
    lector.datos = { ...lector.datos, monto: 250 };
    const { id, pagoId } = await pagoConComprobante();
    await app.get(LecturaComprobantesService).barrer();
    let pago = (await http(`/conversaciones/${id}`)).body['pago'] as { lectura: { verificaciones: { campo: string; texto: string }[] } };
    expect(pago.lectura.verificaciones.find(v => v.campo === 'MONTO')?.texto).toContain('250');
    expect((await http(`/conversaciones/${id}/pagos/${pagoId}/pedir-otro`, 'POST', usuarios.agente.token, { motivo: 'El monto no coincide' })).status).toBe(201);
    expect((await http(`/conversaciones/${id}`)).body['pago']).toMatchObject({ lectura: null });
    lector.datos = { ...lector.datos, monto: 280 };
  });

  it('con la lectura apagada en la línea, no se lee', async () => {
    await configurarAsistente('SUGERIR', false);
    await pagoConComprobante();
    expect(await app.get(LecturaComprobantesService).barrer()).toBe(0);
  });
});
