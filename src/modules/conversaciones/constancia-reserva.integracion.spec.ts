import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

import { R2Service } from '../../common/storage/r2.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AgendaConsultaClient } from '../agenda/agenda-consulta.client';
import { AgendaMedicosCrmService } from '../agenda/agenda-medicos-crm.service';
import { AsistenteLineasService } from '../asistente/asistente-lineas.service';
import { ImagenHorarioService } from '../asistente/imagen-horario.service';
import { ClasificadorMensajes, LectorComprobantes, TranscriptorAudio, ModeloConversacional } from '../asistente/modelo.port';
import { ConfiguracionIA } from '../asistente/vertex/proveedor-vertex';
import { ConstanciaReservaService } from './constancia-reserva.service';
import { ConversacionesGateway } from './conversaciones.gateway';
import { DespachadorSalienteService } from './despachador-saliente.service';
import { uuidEstable } from './pagos-chat';

/*
 * La constancia contra Postgres real (`crm_test`): lo que importa es lo que
 * queda en la base —un mensaje, una sola vez— y lo que NO sale. La agenda
 * (MySQL), R2 y Meta son dobles: aquí no se prueba su conexión.
 */

const db = new PrismaService('postgresql://crm_app@127.0.0.1:5433/crm_test');
const telefono = '+59170009977';
let linea: string, cliente: string, chat: string;
let numero = 7_000_000 + Math.floor(Math.random() * 1_000_000);

const ajustes: Record<string, string | undefined> = {};
const config = { get: (k: string) => ajustes[k] } as unknown as ConfigService;
let filaAgenda: Record<string, unknown> | null;
const agenda = {
  habilitada: jest.fn(() => true),
  ejecutar: jest.fn(async (trabajo: (c: { execute: () => Promise<unknown> }) => Promise<unknown>) =>
    trabajo({ execute: async () => [filaAgenda ? [filaAgenda] : []] })),
};
const r2 = { habilitado: true, leer: jest.fn(async () => null), subir: jest.fn(async () => undefined) };
const despachador = { texto: jest.fn(async () => undefined) };
const gateway = { emitirActividad: jest.fn() };
const motor = new ImagenHorarioService({} as AgendaMedicosCrmService, {} as R2Service);
/* El real: «¿está encendido el asistente en la línea?» se lee de la base. El proveedor de IA no se usa. */
const asistente = new AsistenteLineasService(
  db, {} as ConfiguracionIA, {} as ModeloConversacional, {} as ClasificadorMensajes, {} as LectorComprobantes, motor, {} as TranscriptorAudio,
);

const servicio = () => new ConstanciaReservaService(
  db, config, agenda as unknown as AgendaConsultaClient, motor, r2 as unknown as R2Service,
  despachador as unknown as DespachadorSalienteService, gateway as unknown as ConversacionesGateway, asistente,
);

/** Una reserva cuyo comprobante acaba de quedar registrado, como la deja el trabajador. */
async function registrada(cambios: { estado?: 'PAGO_REGISTRADO' | 'COMPROBANTE_RECIBIDO'; recibido?: Date } = {}) {
  const reserva = ++numero;
  await db.reservaChat.create({
    data: {
      conversacionId: chat, reservaAgenda: reserva, monto: '150.00', qrClave: 'agenda/qr/7-0123456789abcdef.png',
      estado: cambios.estado ?? 'PAGO_REGISTRADO', comprobanteRecibidoEn: cambios.recibido ?? new Date(),
    },
  });
  filaAgenda = {
    id: reserva, fecha: '2026-10-15', hora: '09:30', medico_id: 7, medico: 'Dra. Sintética', especialidad: 'Ginecología',
    nombre_age: 'Paciente Sintética', telefono_age: '70009977', ci_age: '1234567', obs: null, estado: 'PAGADO', precio_con: '150.00',
    nit: null, razon_social: null, tiene_comprobante: 1, registrada_el: null, registrada_a: null,
  };
  return reserva;
}

beforeAll(async () => { await db.$connect(); });
afterAll(async () => { await db.$disconnect(); });
beforeEach(async () => {
  const sufijo = randomUUID();
  linea = (await db.lineaWhatsapp.create({ data: { nombre: 'Constancia ' + sufijo, phoneNumberId: 'constancia-' + sufijo, tokenEnv: 'TOKEN_SINTETICO_INEXISTENTE', comercial: false, activa: true } })).id;
  /* La línea de prueba: con el asistente encendido, aunque Gemini no esté conectado. */
  await db.asistenteLinea.create({ data: { lineaId: linea, modo: 'SUGERIR' } });
  cliente = (await db.cliente.create({ data: { nombre: 'Paciente sintética de constancia', telefono } })).id;
  chat = (await db.conversacion.create({ data: { clienteId: cliente, lineaId: linea, esperandoRespuesta: false } })).id;
  for (const k of Object.keys(ajustes)) delete ajustes[k];
  agenda.habilitada.mockReturnValue(true);
  agenda.ejecutar.mockClear();
  r2.habilitado = true;
  r2.subir.mockClear();
  despachador.texto.mockClear();
  gateway.emitirActividad.mockClear();
});
afterEach(async () => {
  await db.conversacion.deleteMany({ where: { id: chat } });
  await db.cliente.deleteMany({ where: { id: cliente } });
  await db.lineaWhatsapp.deleteMany({ where: { id: linea } });
});

const mensajes = () => db.mensaje.findMany({ where: { conversacionId: chat } });

it('registrado el comprobante, sale UNA constancia en imagen con su resumen de pie, y no se repite', async () => {
  const reserva = await registrada();
  expect(await servicio().enviar(reserva)).toBe(true);
  expect(await servicio().enviar(reserva)).toBe(false);

  const [m, ...otros] = await mensajes();
  expect(otros).toHaveLength(0);
  expect(m).toMatchObject({
    direccion: 'SALIENTE', tipo: 'IMAGEN', automatico: true, asistente: false,
    clientMessageId: uuidEstable(`reserva-constancia:${reserva}`), mediaMime: 'image/png',
  });
  expect(m.mediaKey).toMatch(new RegExp(`^reservas/constancias/${reserva}-[0-9a-f]{24}\\.png$`));
  expect(m.contenido).toContain('Constancia de su reserva');
  expect(m.contenido).not.toContain(String(reserva));
  expect(m.contenido).toContain('Pago enviado: Bs 150');
  expect(r2.subir).toHaveBeenCalledTimes(1);
  expect(despachador.texto).toHaveBeenCalledTimes(1);
  expect(despachador.texto).toHaveBeenCalledWith({ mensajeId: m.id, conversacionId: chat, telefono }, m.contenido, { key: m.mediaKey, mime: 'image/png', nombre: 'Constancia de reserva.png' });
  expect(gateway.emitirActividad).toHaveBeenCalledWith(chat);
});

it('dos pasadas a la vez guardan una sola constancia', async () => {
  const reserva = await registrada();
  const salieron = await Promise.all([servicio().enviar(reserva), servicio().enviar(reserva)]);
  expect(salieron.filter(Boolean)).toHaveLength(1);
  expect(await mensajes()).toHaveLength(1);
});

it('un automático no marca el chat como respondido ni como sin responder', async () => {
  const reserva = await registrada();
  await servicio().enviar(reserva);
  expect((await db.conversacion.findUniqueOrThrow({ where: { id: chat } })).esperandoRespuesta).toBe(false);
});

it('sin R2 sale el mismo resumen en texto', async () => {
  r2.habilitado = false;
  const reserva = await registrada();
  expect(await servicio().enviar(reserva)).toBe(true);
  const [m] = await mensajes();
  expect(m).toMatchObject({ tipo: 'TEXTO', mediaKey: null });
  expect(despachador.texto).toHaveBeenCalledWith(expect.objectContaining({ mensajeId: m.id }), m.contenido, undefined);
});

it('no sale si el comprobante no quedó registrado, si la agenda no lo tiene cargado o si la agenda no responde', async () => {
  const sinRegistrar = await registrada({ estado: 'COMPROBANTE_RECIBIDO' });
  expect(await servicio().enviar(sinRegistrar)).toBe(false);

  const pendiente = await registrada();
  filaAgenda = { ...filaAgenda, estado: 'PENDIENTE' };
  expect(await servicio().enviar(pendiente)).toBe(false);

  const borrada = await registrada();
  filaAgenda = null;
  expect(await servicio().enviar(borrada)).toBe(false);

  const caida = await registrada();
  agenda.ejecutar.mockRejectedValueOnce(new Error('ETIMEDOUT'));
  expect(await servicio().enviar(caida)).toBe(false);

  const sinCuenta = await registrada();
  agenda.habilitada.mockReturnValue(false);
  expect(await servicio().enviar(sinCuenta)).toBe(false);

  expect(await mensajes()).toHaveLength(0);
  expect(despachador.texto).not.toHaveBeenCalled();
});

it('fuera de la ventana de 24 h de Meta no se intenta', async () => {
  const reserva = await registrada({ recibido: new Date(Date.now() - 24 * 3_600_000) });
  expect(await servicio().enviar(reserva)).toBe(false);
  expect(await mensajes()).toHaveLength(0);
});

it('CONSTANCIA_RESERVA=off la apaga sin desplegar', async () => {
  ajustes['CONSTANCIA_RESERVA'] = 'off';
  const reserva = await registrada();
  expect(await servicio().enviar(reserva)).toBe(false);
  expect(agenda.ejecutar).not.toHaveBeenCalled();
  expect(await mensajes()).toHaveLength(0);
});

it('en una línea sin el asistente encendido no sale (Ventas y Recepción, hoy), salvo con CONSTANCIA_RESERVA=todas', async () => {
  await db.asistenteLinea.update({ where: { lineaId: linea }, data: { modo: 'APAGADO' } });
  const reserva = await registrada();
  expect(await servicio().enviar(reserva)).toBe(false);
  expect(agenda.ejecutar).not.toHaveBeenCalled();
  expect(await mensajes()).toHaveLength(0);

  ajustes['CONSTANCIA_RESERVA'] = 'todas';
  expect(await servicio().enviar(reserva)).toBe(true);
  expect(await mensajes()).toHaveLength(1);
});

it('una línea desactivada no la manda aunque tenga el asistente encendido', async () => {
  await db.lineaWhatsapp.update({ where: { id: linea }, data: { activa: false } });
  const reserva = await registrada();
  expect(await servicio().enviar(reserva)).toBe(false);
});
