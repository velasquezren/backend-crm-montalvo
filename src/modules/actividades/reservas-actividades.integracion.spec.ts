import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { PushService } from '../../common/push/push.service';
import { AgendaConsultaClient } from '../agenda/agenda-consulta.client';
import * as sql from '../agenda/agenda-consulta.sql';
import { ConversacionesGateway } from '../conversaciones/conversaciones.gateway';
import { ComprobantesReservaChatService } from '../conversaciones/comprobantes-reserva-chat.service';
import { AgendaReservasService } from '../agenda/agenda-reservas.service';
import { R2Service } from '../../common/storage/r2.service';
import { LineasWhatsappService } from '../lineas-whatsapp/lineas-whatsapp.service';
import { ClientesService } from '../clientes/clientes.service';
import { ReservasActividadesService } from './reservas-actividades.service';
import { ActividadesService } from './actividades.service';
import { QueryActividadDto } from './dto/query-actividad.dto';

const prisma = new PrismaService('postgresql://crm_app:crm_dev_local@127.0.0.1:5433/crm_test');
const config = new ConfigService({ RESERVAS_ACTIVIDADES: 'on' });
const gateway = { emitirActividad: jest.fn(), emitirCambioActividad: jest.fn(async () => undefined), emitirRecordatorioActividad: jest.fn() };
const push = { enviarAUsuario: jest.fn(async () => undefined) };
const agenda = { habilitada: () => true, ejecutar: async <T>(f: (db: never) => Promise<T>) => f({} as never) };
let fuente: sql.FilaReservaAgenda[];
let chat: string, linea: string, recepcion: string, agente: string, ajena: string;
const ahora = new Date('2031-05-10T15:00:00Z');
const siguiente = (minutos: number) => new Date(ahora.getTime() + minutos * 60_000);
const leer = new ActividadesService(prisma, {} as ClientesService, push as unknown as PushService, gateway as unknown as ConversacionesGateway);
const comprobantes = new ComprobantesReservaChatService(prisma, {} as R2Service, {} as AgendaReservasService, gateway as unknown as ConversacionesGateway);
const lineas = new LineasWhatsappService(prisma, config);
const crear = () => new ReservasActividadesService(prisma, config, agenda as unknown as AgendaConsultaClient,
  comprobantes, lineas, gateway as unknown as ConversacionesGateway, push as unknown as PushService);
const consulta = () => Object.assign(new QueryActividadDto(), { pagina: 1, limite: 100 });

function reserva(id = 900001): sql.FilaReservaAgenda {
  return { id, fecha: '2031-05-15', hora: '16:00', medicoId: 1, medico: 'Profesional sintético', especialidad: 'Consulta',
    paciente: 'Paciente sintética', telefono: '70000001', ci: null, observaciones: null, estado: 'PENDIENTE', precio: '250.00',
    nit: null, razonSocial: null, tieneComprobante: false, registradaEl: '2031-05-10', registradaA: '10:00' };
}

async function limpiar() {
  await prisma.actividad.deleteMany({ where: { reservaAgenda: { gte: 900000 } } });
  await prisma.conversacion.deleteMany({ where: { linea: { nombre: 'Integración reservas actividades' } } });
  await prisma.lineaWhatsapp.deleteMany({ where: { nombre: 'Integración reservas actividades' } });
  await prisma.cliente.deleteMany({ where: { telefono: '+59170009001' } });
  await prisma.usuario.deleteMany({ where: { email: { endsWith: '@reservas-actividad.test' } } });
}
beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => { await limpiar(); await prisma.$disconnect(); });
beforeEach(async () => {
  jest.restoreAllMocks(); jest.clearAllMocks();
  await limpiar();
  const usuarios = await Promise.all([
    prisma.usuario.create({ data: { nombre: 'Recepción sintética', email: 'recepcion@reservas-actividad.test', passwordHash: 'x', rol: 'RECEPCION' } }),
    prisma.usuario.create({ data: { nombre: 'Agente sintética', email: 'agente@reservas-actividad.test', passwordHash: 'x', rol: 'AGENTE' } }),
    prisma.usuario.create({ data: { nombre: 'Ajena sintética', email: 'ajena@reservas-actividad.test', passwordHash: 'x', rol: 'AGENTE' } }),
  ]);
  [recepcion, agente, ajena] = usuarios.map(u => u.id);
  linea = (await prisma.lineaWhatsapp.create({ data: { nombre: 'Integración reservas actividades', comercial: false, tokenEnv: 'TEST_RESERVAS_TOKEN', phoneNumberId: '900001' } })).id;
  await prisma.accesoLineaWhatsapp.createMany({ data: [recepcion, agente].map(usuarioId => ({ usuarioId, lineaId: linea })) });
  const cliente = await prisma.cliente.create({ data: { nombre: 'Contacto sintético', telefono: '+59170009001' } });
  chat = (await prisma.conversacion.create({ data: { clienteId: cliente.id, lineaId: linea } })).id;
  fuente = [reserva(), reserva(900002)];
  await prisma.reservaChat.create({ data: { conversacionId: chat, reservaAgenda: fuente[0]!.id, estado: 'ESPERANDO_COMPROBANTE' } });
  jest.spyOn(sql, 'reservasParaSeguimiento').mockImplementation(async (_db, _desde, despues, limite) => fuente.filter(r => r.id > despues).slice(0, limite));
  jest.spyOn(sql, 'reservasPorIds').mockImplementation(async (_db, ids) => fuente.filter(r => ids.includes(r.id)));
});

it('crea una sola tarea compartida por reserva y avisa solo a quienes pueden verla, también con dos trabajadores', async () => {
  await Promise.all([crear().sincronizar(ahora), crear().sincronizar(ahora)]);
  const actividades = await prisma.actividad.findMany({ where: { reservaAgenda: { gte: 900000 } } });
  expect(actividades).toHaveLength(2);
  expect(actividades.every(a => a.agenteId === null)).toBe(true);
  const privada = actividades.find(a => a.reservaAgenda === 900001)!;
  expect(privada.conversacionId).toBe(chat);
  expect((await leer.findAll(consulta(), recepcion)).datos.map(a => a.id)).toEqual(expect.arrayContaining(actividades.map(a => a.id)));
  expect((await leer.findAll(consulta(), agente)).datos.map(a => a.id)).toEqual([privada.id]);
  expect((await leer.findAll(consulta(), ajena)).datos).toHaveLength(0);
  await expect(leer.findOne(privada.id, ajena)).rejects.toMatchObject({ status: 404 });
  const enviados = [...push.enviarAUsuario.mock.calls] as unknown as [string, { tag: string }][];
  expect(enviados.filter(([u, p]) => u === agente && p.tag === `actividad-${privada.id}`)).toHaveLength(1);
  expect(enviados.some(([u]) => u === ajena)).toBe(false);
  await crear().sincronizar(siguiente(1));
  expect(push.enviarAUsuario).toHaveBeenCalledTimes(enviados.length);
});

it('el comprobante cambia la tarea, ATENDIDO la completa y cierra la espera del QR; reabrir conserva revisión humana', async () => {
  const worker = crear(); await worker.sincronizar(ahora);
  const inicial = await prisma.actividad.findUniqueOrThrow({ where: { reservaAgenda: 900001 } });
  fuente[0] = { ...fuente[0]!, estado: 'PAGADO', tieneComprobante: true };
  await worker.sincronizar(siguiente(1));
  expect(await prisma.actividad.findUnique({ where: { id: inicial.id } })).toMatchObject({ estado: 'PENDIENTE', titulo: 'Verificar comprobante de reserva #900001' });
  expect(await prisma.reservaChat.findUnique({ where: { reservaAgenda: 900001 } })).toMatchObject({ estado: 'PAGO_REGISTRADO' });
  fuente[0]!.estado = 'ATENDIDO';
  await worker.sincronizar(siguiente(2));
  expect(await prisma.actividad.findUnique({ where: { id: inicial.id } })).toMatchObject({ estado: 'COMPLETADA' });
  expect(await prisma.reservaChat.findUnique({ where: { reservaAgenda: 900001 } })).toMatchObject({ estado: 'GESTIONADA', proximoIntento: null });
  fuente[0]!.estado = 'PENDIENTE';
  await worker.sincronizar(siguiente(3));
  expect(await prisma.actividad.findUnique({ where: { id: inicial.id } })).toMatchObject({ estado: 'PENDIENTE', completadaEn: null });
  expect(await prisma.reservaChat.findUnique({ where: { reservaAgenda: 900001 } })).toMatchObject({ estado: 'REVISION' });
});

it('no permite completar, posponer, editar ni borrar una tarea automática mediante las rutas manuales', async () => {
  await crear().sincronizar(ahora);
  const a = await prisma.actividad.findUniqueOrThrow({ where: { reservaAgenda: 900001 } });
  await expect(leer.actualizarEstado(a.id, { estado: 'COMPLETADA' }, agente)).rejects.toMatchObject({ status: 400 });
  await expect(leer.update(a.id, { titulo: 'Ocultar reserva' }, agente)).rejects.toMatchObject({ status: 400 });
  await expect(leer.remove(a.id, agente)).rejects.toMatchObject({ status: 400 });
  await expect(leer.cancelarFuturas(a.id, agente)).rejects.toMatchObject({ status: 400 });
  expect((await prisma.actividad.findUniqueOrThrow({ where: { id: a.id } })).estado).toBe('PENDIENTE');
});

it('una caída de la agenda conserva la tarea; una ausencia confirmada la cancela sin inventar una confirmación', async () => {
  const worker = crear(); await worker.sincronizar(ahora);
  jest.mocked(sql.reservasPorIds).mockRejectedValueOnce(new Error('Agenda no disponible'));
  await expect(worker.sincronizar(siguiente(1))).rejects.toThrow('Agenda no disponible');
  expect((await prisma.actividad.findUniqueOrThrow({ where: { reservaAgenda: 900001 } })).estado).toBe('PENDIENTE');
  fuente = fuente.filter(r => r.id !== 900001);
  await worker.sincronizar(siguiente(2));
  expect((await prisma.actividad.findUniqueOrThrow({ where: { reservaAgenda: 900001 } })).estado).toBe('CANCELADA');
});

it('revocar acceso a la línea retira listado y detalle aunque el contacto siga vinculado', async () => {
  await crear().sincronizar(ahora);
  const a = await prisma.actividad.findUniqueOrThrow({ where: { reservaAgenda: 900001 } });
  await prisma.accesoLineaWhatsapp.delete({ where: { usuarioId_lineaId: { usuarioId: agente, lineaId: linea } } });
  expect((await leer.findAll(consulta(), agente)).datos).toHaveLength(0);
  await expect(leer.findOne(a.id, agente)).rejects.toMatchObject({ status: 404 });
});

it('el silencio conserva la campana y suprime el aviso del pool; una reserva sin ficha sigue siendo gestionable', async () => {
  await prisma.silencioLinea.create({ data: { usuarioId: agente, lineaId: linea } });
  await crear().sincronizar(ahora);
  expect((await leer.findAll(consulta(), agente)).datos).toHaveLength(1);
  expect((push.enviarAUsuario.mock.calls as unknown as [string, unknown][]).some(([u]) => u === agente)).toBe(false);
  expect((await prisma.actividad.findUniqueOrThrow({ where: { reservaAgenda: 900002 } })).clienteId).toBeNull();
});

it('un lote lleno continúa desde su cursor, y no oculta reservas detrás del límite', async () => {
  fuente = Array.from({ length: 53 }, (_, i) => reserva(900001 + i));
  const worker = crear(); await worker.sincronizar(ahora); await worker.sincronizar(siguiente(1));
  expect(await prisma.actividad.count({ where: { reservaAgenda: { gte: 900000 } } })).toBe(53);
});

it('el interruptor apagado no lee la agenda, crea tareas ni notifica', async () => {
  const apagado = new ReservasActividadesService(prisma, new ConfigService({ RESERVAS_ACTIVIDADES: 'off' }), agenda as unknown as AgendaConsultaClient,
    comprobantes, lineas, gateway as unknown as ConversacionesGateway, push as unknown as PushService);
  expect(await apagado.sincronizar(ahora)).toBe(0);
  expect(sql.reservasParaSeguimiento).not.toHaveBeenCalled();
  expect(push.enviarAUsuario).not.toHaveBeenCalled();
});

it('una lectura atrasada no revierte la tarea ni el QR ya gestionados por otra pasada', async () => {
  await crear().sincronizar(ahora);
  const antigua = fuente.map(r => ({ ...r }));
  let resolver!: (r: sql.FilaReservaAgenda[]) => void;
  let iniciado!: () => void;
  const empezo = new Promise<void>(r => { iniciado = r; });
  jest.mocked(sql.reservasPorIds).mockImplementationOnce(async () => {
    iniciado(); return new Promise(r => { resolver = r; });
  });
  const vieja = crear().sincronizar(siguiente(1)); await empezo;
  fuente[0]!.estado = 'ATENDIDO';
  await crear().sincronizar(siguiente(2));
  resolver(antigua); await vieja;
  expect((await prisma.actividad.findUniqueOrThrow({ where: { reservaAgenda: 900001 } })).estado).toBe('COMPLETADA');
  expect((await prisma.reservaChat.findUniqueOrThrow({ where: { reservaAgenda: 900001 } })).estado).toBe('GESTIONADA');
});

it('un aviso fallido se recupera al vencer la reclamación, sin duplicar la tarea', async () => {
  fuente = [reserva()];
  push.enviarAUsuario.mockRejectedValueOnce(new Error('Canal transitorio'));
  const worker = crear(); await worker.sincronizar(ahora);
  const pendiente = await prisma.actividad.findUniqueOrThrow({ where: { reservaAgenda: 900001 } });
  expect(pendiente.notificadaEn).toBeNull();
  await worker.notificarPendientes(siguiente(1));
  expect(push.enviarAUsuario).toHaveBeenCalledTimes(1);
  await worker.notificarPendientes(siguiente(3));
  expect((await prisma.actividad.findUniqueOrThrow({ where: { reservaAgenda: 900001 } })).notificadaEn).not.toBeNull();
  expect(await prisma.actividad.count({ where: { reservaAgenda: 900001 } })).toBe(1);
});
