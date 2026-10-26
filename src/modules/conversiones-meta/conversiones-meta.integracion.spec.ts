import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AuditService } from '../../common/audit/audit.service';
import { R2Service } from '../../common/storage/r2.service';
import { PrismaService } from '../../prisma/prisma.service';
import { categoriasDePrueba } from '../clientes/categorias.de-prueba';
import { ClientesService } from '../clientes/clientes.service';
import { LINEA_COMERCIAL_INICIAL } from '../conversaciones/acceso-conversacion';
import { LeadsService } from '../leads/leads.service';
import { ServiciosService } from '../servicios/servicios.service';
import { VentasService } from '../ventas/ventas.service';
import { ESPERA_ANTES_DE_AVISAR_MS } from './conversiones-meta';
import { ConversionesMetaService } from './conversiones-meta.service';

/**
 * El aviso de ventas a Meta contra PostgreSQL real: que la fila nace en la
 * transacción de la venta, que se revalida al enviarse, que nunca sale dos
 * veces (Meta no deduplica) y que lo incierto no se reenvía solo. Meta es lo
 * único simulado: es red hacia un tercero.
 */
const URL_TEST = 'postgresql://crm_app:crm_dev_local@localhost:5433/crm_test?schema=public';
if (!URL_TEST.includes('/crm_test')) throw new Error('La suite de integración solo puede correr contra la base crm_test');
const prisma = new PrismaService(URL_TEST);

const ENCENDIDO = { META_CONVERSIONES: 'on', META_CONVERSIONES_DATASET_ID: 'DATASET-1', META_CONVERSIONES_TOKEN: 'token-prueba' };

let ventas: VentasService;
let conversiones: ConversionesMetaService;
let agenteId: string;
let wabaAnterior: string | null;
let fetchOriginal: typeof fetch;
let llamadas: Array<{ url: string; cuerpo: { data: Array<Record<string, unknown>> } }>;

function servicios(config: Record<string, string>) {
  const audit = new AuditService(prisma);
  const clientes = new ClientesService(prisma, audit, new ServiciosService(prisma), categoriasDePrueba(prisma));
  conversiones = new ConversionesMetaService(prisma, new ConfigService(config));
  ventas = new VentasService(prisma, clientes, new LeadsService(prisma, clientes), audit, {} as R2Service, conversiones);
}

/** Meta contesta con `respuesta` y se registra lo que se le mandó. */
function meta(respuesta: { status: number; cuerpo?: unknown } | Error) {
  global.fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    llamadas.push({ url: String(url), cuerpo: JSON.parse(String(init?.body)) });
    if (respuesta instanceof Error) throw respuesta;
    return { status: respuesta.status, json: async () => respuesta.cuerpo ?? {} } as Response;
  }) as typeof fetch;
}

/** Una paciente que entró por el anuncio AD-1 y su lead de primer contacto en la línea comercial. */
async function pacienteDeAnuncio(clic = { anuncioId: 'AD-1', clickId: 'CLID-1' }) {
  const cliente = await prisma.cliente.create({
    data: {
      nombre: 'Paciente de anuncio', telefono: `+5917${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
      datosExtra: { campanaOrigen: { ...clic, fecha: new Date().toISOString() } },
    },
  });
  const conversacion = await prisma.conversacion.create({ data: { clienteId: cliente.id, lineaId: LINEA_COMERCIAL_INICIAL } });
  const lead = await prisma.lead.create({ data: { clienteId: cliente.id, origen: 'FACEBOOK_LEAD_AD', anuncioId: 'AD-1' } });
  /* Como lo deja la ingesta al completar el primer contacto (ver su CHECK). */
  const mensaje = await prisma.mensaje.create({ data: { conversacionId: conversacion.id, direccion: 'ENTRANTE', contenido: 'Hola, vi el anuncio' } });
  await prisma.primerContactoWhatsapp.create({
    data: { conversacionId: conversacion.id, mensajeId: mensaje.id, leadId: lead.id, origen: 'FACEBOOK_LEAD_AD', anuncioId: 'AD-1', intentos: 1 },
  });
  return { clienteId: cliente.id, leadId: lead.id };
}

const despuesDeLaEspera = () => new Date(Date.now() + ESPERA_ANTES_DE_AVISAR_MS + 1_000);

async function limpiar() {
  await prisma.venta.deleteMany();
  await prisma.primerContactoWhatsapp.deleteMany();
  await prisma.mensaje.deleteMany();
  await prisma.lead.deleteMany();
  await prisma.conversacion.deleteMany();
  await prisma.cliente.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.usuario.deleteMany();
}

beforeAll(async () => {
  await prisma.$connect();
  fetchOriginal = global.fetch;
  wabaAnterior = (await prisma.lineaWhatsapp.findUniqueOrThrow({ where: { id: LINEA_COMERCIAL_INICIAL } })).wabaId;
  await prisma.lineaWhatsapp.update({ where: { id: LINEA_COMERCIAL_INICIAL }, data: { wabaId: 'WABA-1' } });
});
afterAll(async () => {
  global.fetch = fetchOriginal;
  await limpiar();
  await prisma.lineaWhatsapp.update({ where: { id: LINEA_COMERCIAL_INICIAL }, data: { wabaId: wabaAnterior } });
  await prisma.$disconnect();
});
beforeEach(async () => {
  await limpiar();
  llamadas = [];
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  agenteId = (await prisma.usuario.create({ data: { nombre: 'vendedora', email: 'v@test.local', passwordHash: 'x', rol: 'AGENTE', activo: true } })).id;
  servicios(ENCENDIDO);
});
afterEach(() => {
  jest.restoreAllMocks();
  global.fetch = fetchOriginal;
});

describe('aviso de ventas a Meta (META_CONVERSIONES=on)', () => {
  it('la venta de un anuncio deja su aviso en la misma transacción y sale pasada la espera, con lo mínimo', async () => {
    const { clienteId, leadId } = await pacienteDeAnuncio();
    const venta = await ventas.create({ clienteId, leadId, producto: 'Consulta', monto: 1200 }, agenteId);
    const fila = await prisma.conversionMeta.findUniqueOrThrow({ where: { ventaId: venta.id } });
    expect(fila.estado).toBe('PENDIENTE');

    meta({ status: 200, cuerpo: { events_received: 1, fbtrace_id: 'TRAZA-1' } });
    expect(await conversiones.barrer(new Date())).toBe(0); // aún no: se deja corregir la venta
    expect(await conversiones.barrer(despuesDeLaEspera())).toBe(1);

    expect(llamadas).toHaveLength(1);
    expect(llamadas[0].url).toBe('https://graph.facebook.com/v25.0/DATASET-1/events');
    expect(llamadas[0].cuerpo.data[0]).toMatchObject({
      event_name: 'Purchase', event_id: venta.id, action_source: 'business_messaging', messaging_channel: 'whatsapp',
      user_data: { whatsapp_business_account_id: 'WABA-1', ctwa_clid: 'CLID-1' }, custom_data: { currency: 'BOB', value: 1200 },
    });
    expect(await prisma.conversionMeta.findUniqueOrThrow({ where: { ventaId: venta.id } })).toMatchObject({ estado: 'ENVIADO', fbtraceId: 'TRAZA-1' });
  });

  it('una venta anulada antes de la espera no se avisa; si vuelve a GANADA, sí; y nunca dos veces', async () => {
    const { clienteId, leadId } = await pacienteDeAnuncio();
    const venta = await ventas.create({ clienteId, leadId, producto: 'Consulta', monto: 500 }, agenteId);
    await ventas.cambiarEstado(venta.id, 'PERDIDA', agenteId, 'Se equivocaron de paciente');

    meta({ status: 200, cuerpo: { events_received: 1 } });
    await conversiones.barrer(despuesDeLaEspera());
    expect(llamadas).toHaveLength(0);
    expect((await prisma.conversionMeta.findUniqueOrThrow({ where: { ventaId: venta.id } })).estado).toBe('DESCARTADO');

    await ventas.cambiarEstado(venta.id, 'GANADA', agenteId);
    await conversiones.barrer(despuesDeLaEspera());
    expect(llamadas).toHaveLength(1);

    await ventas.cambiarEstado(venta.id, 'PERDIDA', agenteId, 'Anulada');
    await ventas.cambiarEstado(venta.id, 'GANADA', agenteId);
    await conversiones.barrer(despuesDeLaEspera());
    expect(llamadas).toHaveLength(1);
    expect((await prisma.conversionMeta.findUniqueOrThrow({ where: { ventaId: venta.id } })).estado).toBe('ENVIADO');
  });

  it('si el último clic de la ficha es de otro anuncio, se descarta sin llamar a Meta', async () => {
    const { clienteId, leadId } = await pacienteDeAnuncio({ anuncioId: 'AD-OTRO', clickId: 'CLID-OTRO' });
    const venta = await ventas.create({ clienteId, leadId, producto: 'Consulta', monto: 300 }, agenteId);
    meta({ status: 200, cuerpo: { events_received: 1 } });
    await conversiones.barrer(despuesDeLaEspera());
    expect(llamadas).toHaveLength(0);
    expect(await prisma.conversionMeta.findUniqueOrThrow({ where: { ventaId: venta.id } }))
      .toMatchObject({ estado: 'DESCARTADO', motivo: 'El último clic guardado es de otro anuncio' });
  });

  it('un corte de red queda INCIERTO y no se reenvía solo; un límite de uso se reintenta más tarde', async () => {
    const corte = await pacienteDeAnuncio();
    const v1 = await ventas.create({ clienteId: corte.clienteId, leadId: corte.leadId, producto: 'Consulta', monto: 100 }, agenteId);
    meta(new Error('socket hang up'));
    await conversiones.barrer(despuesDeLaEspera());
    await conversiones.barrer(despuesDeLaEspera());
    expect(llamadas).toHaveLength(1);
    expect((await prisma.conversionMeta.findUniqueOrThrow({ where: { ventaId: v1.id } })).estado).toBe('INCIERTO');

    llamadas = [];
    const limite = await pacienteDeAnuncio();
    const v2 = await ventas.create({ clienteId: limite.clienteId, leadId: limite.leadId, producto: 'Consulta', monto: 100 }, agenteId);
    meta({ status: 400, cuerpo: { error: { code: 4, message: 'Application request limit reached' } } });
    const cuando = despuesDeLaEspera();
    await conversiones.barrer(cuando);
    const fila = await prisma.conversionMeta.findUniqueOrThrow({ where: { ventaId: v2.id } });
    expect(fila).toMatchObject({ estado: 'PENDIENTE', intentos: 1 });
    expect(fila.proximoIntento.getTime()).toBeGreaterThan(cuando.getTime());
  });

  it('dos barridos a la vez avisan una sola vez', async () => {
    const { clienteId, leadId } = await pacienteDeAnuncio();
    await ventas.create({ clienteId, leadId, producto: 'Consulta', monto: 800 }, agenteId);
    meta({ status: 200, cuerpo: { events_received: 1 } });
    const cuando = despuesDeLaEspera();
    await Promise.all([conversiones.barrer(cuando), conversiones.barrer(cuando)]);
    expect(llamadas).toHaveLength(1);
  });

  it('apagado, no deja filas ni llama a Meta', async () => {
    servicios({});
    const { clienteId, leadId } = await pacienteDeAnuncio();
    const venta = await ventas.create({ clienteId, leadId, producto: 'Consulta', monto: 800 }, agenteId);
    meta({ status: 200, cuerpo: { events_received: 1 } });
    expect(await conversiones.barrer(despuesDeLaEspera())).toBe(0);
    expect(await prisma.conversionMeta.findUnique({ where: { ventaId: venta.id } })).toBeNull();
    expect(llamadas).toHaveLength(0);
  });
});
