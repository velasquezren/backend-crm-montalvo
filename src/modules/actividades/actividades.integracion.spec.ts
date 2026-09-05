import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { AuditService } from '../../common/audit/audit.service';
import { PushService } from '../../common/push/push.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientesService } from '../clientes/clientes.service';
import { ConversacionesGateway } from '../conversaciones/conversaciones.gateway';
import { ServiciosService } from '../servicios/servicios.service';
import { ActividadesService } from './actividades.service';
import { RepetirActividadDto } from './dto/create-actividad.dto';

/**
 * Contra PostgreSQL real (`crm_test` en el :5433 local) — ver `leads.integracion.spec.ts`.
 *
 * Cubre lo que decide Postgres, no el código: el escopado por agente en las
 * cuatro operaciones (no solo el listado), que `create` valide cliente/lead
 * contra el alcance de quien crea, los conteos de `resumen()` y que el barrido
 * de recordatorios notifique una sola vez por actividad.
 *
 * `npm run test:integracion`.
 */

const URL_TEST = 'postgresql://crm_app:crm_dev_local@localhost:5433/crm_test?schema=public';
if (!URL_TEST.includes('/crm_test')) {
  throw new Error('La suite de integración solo puede correr contra la base crm_test');
}

const prisma = new PrismaService(URL_TEST);
let service: ActividadesService;
let push: PushService;
const enviosSimulados: Array<{ usuarioId: string; tag?: string }> = [];
const avisosRealtimeSimulados: Array<{ actividadId: string; agenteId: string }> = [];
/* Stub, no un ConversacionesGateway real: ese exige JwtService + un
   @WebSocketServer inyectado por Nest, que no existe fuera del bootstrap
   completo. Alcanza con la única forma que usa ActividadesService. */
const realtimeGatewayStub = {
  emitirRecordatorioActividad: (actividadId: string, agenteId: string) => {
    avisosRealtimeSimulados.push({ actividadId, agenteId });
  },
} as unknown as ConversacionesGateway;

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.actividad.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.lead.deleteMany();
  await prisma.conversacion.deleteMany();
  await prisma.cliente.deleteMany();
  await prisma.usuario.deleteMany();

  const clientesService = new ClientesService(
    prisma,
    new AuditService(prisma),
    new ServiciosService(prisma),
  );
  push = new PushService(prisma, new ConfigService({}));
  service = new ActividadesService(prisma, clientesService, push, realtimeGatewayStub);

  enviosSimulados.length = 0;
  avisosRealtimeSimulados.length = 0;
  // `habilitado` queda en false sin llaves VAPID (no se llama a onModuleInit),
  // así que `enviarAUsuario` real ya no golpea la red — igual se espía para
  // confirmar A QUIÉN se hubiera notificado, sin depender de webpush.
  jest.spyOn(push, 'enviarAUsuario').mockImplementation(async (usuarioId, payload) => {
    enviosSimulados.push({ usuarioId, tag: payload.tag });
  });
});

async function usuario(nombre: string, email: string, rol: 'AGENTE' | 'ADMIN' = 'AGENTE') {
  return prisma.usuario.create({ data: { nombre, email, passwordHash: 'x', rol } });
}

async function cliente(nombre: string, telefono: string, agenteId?: string) {
  return prisma.cliente.create({ data: { nombre, telefono, agenteId } });
}

describe('ActividadesService — escopado por agente', () => {
  it('findAll de un AGENTE solo trae lo suyo', async () => {
    const yo = await usuario('Yo', 'yo@test.local');
    const otro = await usuario('Otro', 'otro@test.local');
    const clienteYo = await cliente('Ana', '+59170000001', yo.id);
    const clienteOtro = await cliente('Beto', '+59170000002', otro.id);
    await prisma.actividad.create({
      data: { tipo: 'TAREA', titulo: 'Mío', fechaProgramada: new Date(), clienteId: clienteYo.id, agenteId: yo.id },
    });
    await prisma.actividad.create({
      data: { tipo: 'TAREA', titulo: 'Ajeno', fechaProgramada: new Date(), clienteId: clienteOtro.id, agenteId: otro.id },
    });

    const resultado = await service.findAll({}, yo.id);

    expect(resultado.datos).toHaveLength(1);
    expect(resultado.datos[0]!.titulo).toBe('Mío');
  });

  it('un ADMIN (sin soloAgenteId) ve las de todos', async () => {
    const yo = await usuario('Yo', 'yo@test.local');
    const otro = await usuario('Otro', 'otro@test.local');
    const clienteYo = await cliente('Ana', '+59170000001', yo.id);
    const clienteOtro = await cliente('Beto', '+59170000002', otro.id);
    await prisma.actividad.create({
      data: { tipo: 'TAREA', titulo: 'Mío', fechaProgramada: new Date(), clienteId: clienteYo.id, agenteId: yo.id },
    });
    await prisma.actividad.create({
      data: { tipo: 'TAREA', titulo: 'Ajeno', fechaProgramada: new Date(), clienteId: clienteOtro.id, agenteId: otro.id },
    });

    const resultado = await service.findAll({}, undefined);

    expect(resultado.total).toBe(2);
  });

  it('findOne/update/actualizarEstado/remove dan 404 sobre una actividad ajena', async () => {
    const yo = await usuario('Yo', 'yo@test.local');
    const otro = await usuario('Otro', 'otro@test.local');
    const clienteOtro = await cliente('Beto', '+59170000002', otro.id);
    const ajena = await prisma.actividad.create({
      data: { tipo: 'TAREA', titulo: 'Ajeno', fechaProgramada: new Date(), clienteId: clienteOtro.id, agenteId: otro.id },
    });

    await expect(service.findOne(ajena.id, yo.id)).rejects.toThrow('no encontrada');
    await expect(service.update(ajena.id, { titulo: 'Hackeado' }, yo.id)).rejects.toThrow(
      'no encontrada',
    );
    await expect(service.actualizarEstado(ajena.id, { estado: 'COMPLETADA' }, yo.id)).rejects.toThrow(
      'no encontrada',
    );
    await expect(service.remove(ajena.id, yo.id)).rejects.toThrow('no encontrada');

    const sinCambios = await prisma.actividad.findUniqueOrThrow({ where: { id: ajena.id } });
    expect(sinCambios.titulo).toBe('Ajeno');
    expect(sinCambios.estado).toBe('PENDIENTE');
  });
});

describe('ActividadesService.create', () => {
  it('un AGENTE no puede agendar sobre un cliente ajeno', async () => {
    const yo = await usuario('Yo', 'yo@test.local');
    const otro = await usuario('Otro', 'otro@test.local');
    const clienteOtro = await cliente('Beto', '+59170000002', otro.id);

    await expect(
      service.create(
        { tipo: 'LLAMADA', titulo: 'Llamar', fechaProgramada: new Date(), clienteId: clienteOtro.id },
        { sub: yo.id, email: yo.email, nombre: yo.nombre, rol: 'AGENTE' },
      ),
    ).rejects.toThrow('no encontrado');
  });

  it('un AGENTE siempre queda como dueño, aunque mande otro agenteId en el body', async () => {
    const yo = await usuario('Yo', 'yo@test.local');
    const otro = await usuario('Otro', 'otro@test.local');
    const clienteYo = await cliente('Ana', '+59170000001', yo.id);

    const creada = await service.create(
      {
        tipo: 'LLAMADA',
        titulo: 'Llamar a Ana',
        fechaProgramada: new Date(),
        clienteId: clienteYo.id,
        agenteId: otro.id,
      },
      { sub: yo.id, email: yo.email, nombre: yo.nombre, rol: 'AGENTE' },
    );

    expect(creada.agenteId).toBe(yo.id);
  });

  it('un ADMIN sí puede agendarle una tarea a otro agente', async () => {
    const admin = await usuario('Admin', 'admin@test.local', 'ADMIN');
    const agente = await usuario('Agente', 'agente@test.local');
    const clienteDeAgente = await cliente('Ana', '+59170000001', agente.id);

    const creada = await service.create(
      {
        tipo: 'TAREA',
        titulo: 'Seguimiento',
        fechaProgramada: new Date(),
        clienteId: clienteDeAgente.id,
        agenteId: agente.id,
      },
      { sub: admin.id, email: admin.email, nombre: admin.nombre, rol: 'ADMIN' },
    );

    expect(creada.agenteId).toBe(agente.id);
  });

  it('rechaza un leadId que no pertenece al clienteId indicado', async () => {
    const yo = await usuario('Yo', 'yo@test.local');
    const clienteYo = await cliente('Ana', '+59170000001', yo.id);
    const otroCliente = await cliente('Cira', '+59170000003', yo.id);
    const leadDeOtroCliente = await prisma.lead.create({
      data: { clienteId: otroCliente.id, origen: 'WHATSAPP_DIRECTO', agenteId: yo.id },
    });

    await expect(
      service.create(
        {
          tipo: 'LLAMADA',
          titulo: 'Llamar',
          fechaProgramada: new Date(),
          clienteId: clienteYo.id,
          leadId: leadDeOtroCliente.id,
        },
        { sub: yo.id, email: yo.email, nombre: yo.nombre, rol: 'AGENTE' },
      ),
    ).rejects.toThrow('no encontrado');
  });
});

describe('ActividadesService.resumen', () => {
  it('clasifica vencidas / hoy / próxima semana correctamente', async () => {
    const yo = await usuario('Yo', 'yo@test.local');
    const clienteYo = await cliente('Ana', '+59170000001', yo.id);
    const ahora = new Date();
    const ayer = new Date(ahora.getTime() - 24 * 60 * 60 * 1000);
    const enTresDias = new Date(ahora.getTime() + 3 * 24 * 60 * 60 * 1000);

    await prisma.actividad.create({
      data: { tipo: 'TAREA', titulo: 'Vencida', fechaProgramada: ayer, clienteId: clienteYo.id, agenteId: yo.id },
    });
    await prisma.actividad.create({
      data: { tipo: 'TAREA', titulo: 'Hoy', fechaProgramada: ahora, clienteId: clienteYo.id, agenteId: yo.id },
    });
    await prisma.actividad.create({
      data: {
        tipo: 'TAREA',
        titulo: 'Próxima semana',
        fechaProgramada: enTresDias,
        clienteId: clienteYo.id,
        agenteId: yo.id,
      },
    });
    // Completada: cuenta en su propio cubo y en ningún otro, aunque su fecha
    // sea de ayer — no es una vencida.
    await prisma.actividad.create({
      data: {
        tipo: 'TAREA',
        titulo: 'Completada',
        fechaProgramada: ayer,
        estado: 'COMPLETADA',
        completadaEn: ahora,
        clienteId: clienteYo.id,
        agenteId: yo.id,
      },
    });

    const resumen = await service.resumen({}, yo.id);

    expect(resumen).toEqual({ vencidas: 1, hoy: 1, proximaSemana: 1, completadas: 1 });
  });
});

describe('ActividadesService.barrerRecordatoriosPendientes', () => {
  it('notifica una actividad dentro de la ventana y no la vuelve a notificar', async () => {
    const yo = await usuario('Yo', 'yo@test.local');
    const clienteYo = await cliente('Ana', '+59170000001', yo.id);
    const en10Min = new Date(Date.now() + 10 * 60 * 1000);
    const actividad = await prisma.actividad.create({
      data: {
        tipo: 'LLAMADA',
        titulo: 'Llamar a Ana',
        fechaProgramada: en10Min,
        clienteId: clienteYo.id,
        agenteId: yo.id,
      },
    });

    const notificadas = await service.barrerRecordatoriosPendientes();
    expect(notificadas).toBe(1);
    expect(enviosSimulados).toEqual([{ usuarioId: yo.id, tag: `actividad-${actividad.id}` }]);
    // Los dos canales, con los mismos datos — ni push sin socket ni al revés.
    expect(avisosRealtimeSimulados).toEqual([{ actividadId: actividad.id, agenteId: yo.id }]);

    const actualizada = await prisma.actividad.findUniqueOrThrow({ where: { id: actividad.id } });
    expect(actualizada.notificadaEn).not.toBeNull();

    // Segunda pasada: ya tiene `notificadaEn`, no debe volver a mandar el push.
    const segundaPasada = await service.barrerRecordatoriosPendientes();
    expect(segundaPasada).toBe(0);
    expect(enviosSimulados).toHaveLength(1);
    expect(avisosRealtimeSimulados).toHaveLength(1);
  });

  it('ignora una actividad fuera de la ventana de 15 minutos', async () => {
    const yo = await usuario('Yo', 'yo@test.local');
    const clienteYo = await cliente('Ana', '+59170000001', yo.id);
    const enUnaHora = new Date(Date.now() + 60 * 60 * 1000);
    await prisma.actividad.create({
      data: {
        tipo: 'LLAMADA',
        titulo: 'Llamar más tarde',
        fechaProgramada: enUnaHora,
        clienteId: clienteYo.id,
        agenteId: yo.id,
      },
    });

    const notificadas = await service.barrerRecordatoriosPendientes();
    expect(notificadas).toBe(0);
    expect(enviosSimulados).toHaveLength(0);
  });

  it('reprogramar una actividad ya notificada limpia notificadaEn para poder avisar de nuevo', async () => {
    const yo = await usuario('Yo', 'yo@test.local');
    const clienteYo = await cliente('Ana', '+59170000001', yo.id);
    const actividad = await prisma.actividad.create({
      data: {
        tipo: 'LLAMADA',
        titulo: 'Llamar a Ana',
        fechaProgramada: new Date(Date.now() + 5 * 60 * 1000),
        clienteId: clienteYo.id,
        agenteId: yo.id,
        notificadaEn: new Date(),
      },
    });

    const actualizada = await service.update(
      actividad.id,
      { fechaProgramada: new Date(Date.now() + 10 * 60 * 1000) },
      yo.id,
    );

    expect(actualizada.notificadaEn).toBeNull();
  });
});

describe('ActividadesService.create — duración', () => {
  it('usa el default del schema (30) si no llega duracionMinutos', async () => {
    const yo = await usuario('Yo', 'yo@test.local');
    const clienteYo = await cliente('Ana', '+59170000001', yo.id);

    const creada = await service.create(
      { tipo: 'LLAMADA', titulo: 'Llamar', fechaProgramada: new Date(), clienteId: clienteYo.id },
      { sub: yo.id, email: yo.email, nombre: yo.nombre, rol: 'AGENTE' },
    );

    expect(creada.duracionMinutos).toBe(30);
  });

  it('respeta el duracionMinutos explícito', async () => {
    const yo = await usuario('Yo', 'yo@test.local');
    const clienteYo = await cliente('Ana', '+59170000001', yo.id);

    const creada = await service.create(
      {
        tipo: 'REUNION',
        titulo: 'Reunión con el paciente',
        fechaProgramada: new Date(),
        clienteId: clienteYo.id,
        duracionMinutos: 60,
      },
      { sub: yo.id, email: yo.email, nombre: yo.nombre, rol: 'AGENTE' },
    );

    expect(creada.duracionMinutos).toBe(60);
  });
});

describe('ActividadesService.create — repetir', () => {
  it('sin repetir crea una sola fila', async () => {
    const yo = await usuario('Yo', 'yo@test.local');
    const clienteYo = await cliente('Ana', '+59170000001', yo.id);

    await service.create(
      { tipo: 'TAREA', titulo: 'Tarea suelta', fechaProgramada: new Date(), clienteId: clienteYo.id },
      { sub: yo.id, email: yo.email, nombre: yo.nombre, rol: 'AGENTE' },
    );

    const total = await prisma.actividad.count({ where: { clienteId: clienteYo.id } });
    expect(total).toBe(1);
  });

  it('con repetir SEMANAL x4 crea 4 filas independientes, una por semana', async () => {
    const yo = await usuario('Yo', 'yo@test.local');
    const clienteYo = await cliente('Ana', '+59170000001', yo.id);
    const inicio = new Date('2026-09-07T15:00:00.000Z'); // lunes

    await service.create(
      {
        tipo: 'LLAMADA',
        titulo: 'Seguimiento semanal',
        fechaProgramada: inicio,
        clienteId: clienteYo.id,
        repetir: { frecuencia: 'SEMANAL', veces: 4 },
      },
      { sub: yo.id, email: yo.email, nombre: yo.nombre, rol: 'AGENTE' },
    );

    const filas = await prisma.actividad.findMany({
      where: { clienteId: clienteYo.id },
      orderBy: { fechaProgramada: 'asc' },
    });

    expect(filas).toHaveLength(4);
    expect(filas.map(f => f.fechaProgramada.toISOString())).toEqual([
      '2026-09-07T15:00:00.000Z',
      '2026-09-14T15:00:00.000Z',
      '2026-09-21T15:00:00.000Z',
      '2026-09-28T15:00:00.000Z',
    ]);
    // Independientes de verdad: cada una se puede completar por separado.
    expect(new Set(filas.map(f => f.id)).size).toBe(4);
    expect(filas.every(f => f.estado === 'PENDIENTE')).toBe(true);
  });

  it('con repetir MENSUAL x3 avanza mes a mes', async () => {
    const yo = await usuario('Yo', 'yo@test.local');
    const clienteYo = await cliente('Ana', '+59170000001', yo.id);
    const inicio = new Date('2026-09-10T14:00:00.000Z');

    await service.create(
      {
        tipo: 'RECORDATORIO',
        titulo: 'Control mensual',
        fechaProgramada: inicio,
        clienteId: clienteYo.id,
        repetir: { frecuencia: 'MENSUAL', veces: 3 },
      },
      { sub: yo.id, email: yo.email, nombre: yo.nombre, rol: 'AGENTE' },
    );

    const filas = await prisma.actividad.findMany({
      where: { clienteId: clienteYo.id },
      orderBy: { fechaProgramada: 'asc' },
    });

    expect(filas.map(f => f.fechaProgramada.toISOString())).toEqual([
      '2026-09-10T14:00:00.000Z',
      '2026-10-10T14:00:00.000Z',
      '2026-11-10T14:00:00.000Z',
    ]);
  });

  it('la repetición respeta duracionMinutos y el resto de campos comunes', async () => {
    const yo = await usuario('Yo', 'yo@test.local');
    const otro = await usuario('Otro', 'otro@test.local');
    const clienteYo = await cliente('Ana', '+59170000001', yo.id);
    const lead = await prisma.lead.create({
      data: { clienteId: clienteYo.id, origen: 'WHATSAPP_DIRECTO', agenteId: yo.id },
    });

    await service.create(
      {
        tipo: 'LLAMADA',
        titulo: 'Seguimiento',
        notas: 'Preguntar por el resultado',
        fechaProgramada: new Date(),
        duracionMinutos: 15,
        clienteId: clienteYo.id,
        leadId: lead.id,
        repetir: { frecuencia: 'SEMANAL', veces: 2 },
      },
      { sub: yo.id, email: yo.email, nombre: yo.nombre, rol: 'AGENTE' },
    );

    const filas = await prisma.actividad.findMany({ where: { clienteId: clienteYo.id } });
    expect(filas).toHaveLength(2);
    for (const fila of filas) {
      expect(fila.duracionMinutos).toBe(15);
      expect(fila.notas).toBe('Preguntar por el resultado');
      expect(fila.leadId).toBe(lead.id);
      expect(fila.agenteId).toBe(yo.id);
      expect(fila.agenteId).not.toBe(otro.id);
    }
  });

  it('el DTO rechaza veces fuera de 2-12 antes de llegar al service', async () => {
    // El service confía en que `veces` ya viene validado — lo valida el
    // ValidationPipe global (class-validator), no el service. Se prueba acá
    // directamente contra el DTO para no montar todo Nest solo por esto.
    const unaVezSola = plainToInstance(RepetirActividadDto, { frecuencia: 'SEMANAL', veces: 1 });
    const trece = plainToInstance(RepetirActividadDto, { frecuencia: 'SEMANAL', veces: 13 });
    const valida = plainToInstance(RepetirActividadDto, { frecuencia: 'SEMANAL', veces: 4 });

    expect(await validate(unaVezSola)).not.toHaveLength(0);
    expect(await validate(trece)).not.toHaveLength(0);
    expect(await validate(valida)).toHaveLength(0);
  });
});
