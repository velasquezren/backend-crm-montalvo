import { ConfigService } from '@nestjs/config';

import { AuditService } from '../../common/audit/audit.service';
import { R2Service } from '../../common/storage/r2.service';
import { WhatsappCloudService } from '../../common/whatsapp/whatsapp-cloud.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientesService } from '../clientes/clientes.service';
import { PrimerContactoService } from '../leads/primer-contacto.service';
import { LineasWhatsappService } from '../lineas-whatsapp/lineas-whatsapp.service';
import { MemoriaAgenteService } from '../memoria-agente/memoria-agente.service';
import { ServiciosService } from '../servicios/servicios.service';
import { AcuseAutomaticoService } from './acuse-automatico.service';
import { ConversacionesGateway } from './conversaciones.gateway';
import { ConversacionesService } from './conversaciones.service';
import { DespachadorSalienteService } from './despachador-saliente.service';
import { IngestaWhatsappService } from './ingesta-whatsapp.service';
import { MediaEntranteService } from './media-entrante.service';
import { PlantillaMeta } from './plantillas-whatsapp';

/**
 * Escribirle primero a alguien desde cualquier línea — `iniciarConversacion`.
 *
 * Contra PostgreSQL real (`crm_test`). Lo único doblado es Meta: la lista de
 * plantillas aprobadas y el envío, que son red. Lo que se quiere demostrar lo
 * deciden Postgres y el orden de las comprobaciones: que un número escrito a
 * mano sea la MISMA ficha que luego encuentra el webhook, que un doble clic no
 * mande dos plantillas, y que un intento rechazado no deje fichas ni chats.
 *
 * `npm run test:integracion`.
 */

const URL_TEST = 'postgresql://crm_app:crm_dev_local@localhost:5433/crm_test?schema=public';
if (!URL_TEST.includes('/crm_test')) {
  throw new Error('La suite de integración solo puede correr contra la base crm_test');
}

const prisma = new PrismaService(URL_TEST);

const VENTAS = '44444444-4444-4444-8444-444444444401';
const RECEPCION = '44444444-4444-4444-8444-444444444402';
const DESCONECTADA = '44444444-4444-4444-8444-444444444403';

const PLANTILLAS: PlantillaMeta[] = [
  {
    name: 'seguimiento',
    status: 'APPROVED',
    category: 'MARKETING',
    language: 'es',
    components: [
      { type: 'BODY', text: 'Hola {{1}}, te escribimos de Clínica Montalvo por tu consulta de {{2}}.' },
      { type: 'FOOTER', text: 'Responde para hablar con nosotros' },
    ],
  },
  { name: 'saludo', status: 'APPROVED', category: 'UTILITY', language: 'es', components: [{ type: 'BODY', text: 'Hola, ¿en qué te ayudamos?' }] },
  { name: 'pendiente', status: 'PENDING', category: 'UTILITY', language: 'es', components: [{ type: 'BODY', text: 'x' }] },
];

class GatewayMudo {
  emitirActividad(): void {}
  notificarEntrante(): void {}
}

let service: ConversacionesService;
let ingesta: IngestaWhatsappService;
let envios: Array<{ telefono: string; cuerpo: Record<string, unknown> }>;

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await limpiar();
  await prisma.lineaWhatsapp.deleteMany({ where: { id: { in: [VENTAS, RECEPCION, DESCONECTADA] } } });
  await prisma.$disconnect();
});

async function limpiar() {
  await prisma.auditLog.deleteMany();
  await prisma.mensaje.deleteMany();
  await prisma.conversacion.deleteMany();
  await prisma.lead.deleteMany();
  await prisma.venta.deleteMany();
  await prisma.cliente.deleteMany();
  await prisma.usuario.deleteMany();
}

beforeEach(async () => {
  await limpiar();
  for (const [id, nombre, comercial, activa, numero] of [
    [VENTAS, 'Ventas prueba', true, true, '9001'],
    [RECEPCION, 'Recepción prueba', false, true, '9002'],
    [DESCONECTADA, 'Sin conectar', false, false, '9003'],
  ] as const) {
    await prisma.lineaWhatsapp.upsert({
      where: { id },
      create: { id, nombre, comercial, activa, phoneNumberId: numero, wabaId: `waba-${numero}`, tokenEnv: 'TOKEN_PRUEBA_INICIAR' },
      update: { nombre, comercial, activa, phoneNumberId: numero, wabaId: `waba-${numero}`, tokenEnv: 'TOKEN_PRUEBA_INICIAR' },
    });
  }

  const config = new ConfigService({ TOKEN_PRUEBA_INICIAR: 'token' });
  const gateway = new GatewayMudo() as unknown as ConversacionesGateway;
  const r2 = {} as R2Service;
  const clientes = new ClientesService(prisma, new AuditService(prisma), new ServiciosService(prisma));
  const whatsapp = new WhatsappCloudService();
  envios = [];
  jest.spyOn(whatsapp, 'listarPlantillas').mockResolvedValue(PLANTILLAS);
  jest.spyOn(whatsapp, 'enviar').mockImplementation(async (telefono, cuerpo) => {
    envios.push({ telefono, cuerpo: cuerpo as unknown as Record<string, unknown> });
    return { estado: 'ENVIADO' as const, metaMsgId: `wamid.${envios.length}` };
  });
  const lineas = new LineasWhatsappService(prisma, config);
  const despachador = new DespachadorSalienteService(prisma, gateway, r2, whatsapp, lineas);
  service = new ConversacionesService(prisma, clientes, gateway, r2, whatsapp, despachador, lineas, new MemoriaAgenteService(prisma, r2));
  ingesta = new IngestaWhatsappService(
    prisma, clientes, gateway, new AcuseAutomaticoService(config), despachador,
    new MediaEntranteService(prisma, gateway, r2, whatsapp, lineas),
    new PrimerContactoService(prisma, clientes),
  );
  jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
});

async function agente(nombre: string, lineas: string[]) {
  return prisma.usuario.create({
    data: {
      nombre, email: `${nombre}@test.local`, passwordHash: 'x', rol: 'AGENTE', activo: true,
      lineasWhatsapp: { create: lineas.map(lineaId => ({ lineaId })) },
    },
  });
}

const seguimiento = (extra: Record<string, unknown> = {}) => ({
  plantilla: 'seguimiento',
  idioma: 'es',
  parametros: ['Lucía', 'depilación láser'],
  ...extra,
});

/** Los envíos a Meta salen en segundo plano; se espera a que lleguen. */
async function esperarEnvios(n: number) {
  for (let i = 0; i < 50 && envios.length < n; i++) await new Promise(r => setTimeout(r, 10));
}

describe('iniciar una conversación', () => {
  it('un número escrito a mano es la misma ficha que encuentra el webhook cuando contesta', async () => {
    const ana = await agente('ana', [VENTAS]);

    const { conversacionId, mensaje } = await service.iniciarConversacion(
      { lineaId: VENTAS, telefono: '700 12-345', nombre: 'Lucía Pérez', ...seguimiento() },
      ana.id,
      ana.id,
    );

    expect(mensaje.contenido).toBe(
      'Hola Lucía, te escribimos de Clínica Montalvo por tu consulta de depilación láser.\n\nResponde para hablar con nosotros',
    );
    const cliente = await prisma.cliente.findUniqueOrThrow({ where: { telefono: '+59170012345' } });
    expect(cliente.nombre).toBe('Lucía Pérez');
    /* Línea comercial: quien escribe primero se queda la paciente y el chat. */
    expect(cliente.agenteId).toBe(ana.id);
    expect((await prisma.conversacion.findUniqueOrThrow({ where: { id: conversacionId } })).agenteId).toBe(ana.id);

    await esperarEnvios(1);
    expect(envios[0]!.telefono).toBe('+59170012345');

    /* La paciente contesta: Meta manda `from` sin el `+`. */
    await ingesta.procesarEntrante('+59170012345', 'Hola, sí me interesa', 'wamid.respuesta', 'Lucía', undefined, undefined, false, VENTAS);
    expect(await prisma.cliente.count()).toBe(1);
    expect(await prisma.conversacion.count()).toBe(1);
    expect(await prisma.mensaje.count({ where: { conversacionId } })).toBe(2);
  });

  it('un doble clic manda UNA plantilla, no dos', async () => {
    const ana = await agente('ana', [RECEPCION]);
    const dto = { lineaId: RECEPCION, telefono: '+59170000001', ...seguimiento(), clientMessageId: '0b8a6a52-7a53-4b43-9e1e-4a4c3b7f7c11' };

    const [a, b] = await Promise.all([
      service.iniciarConversacion(dto, ana.id, ana.id),
      service.iniciarConversacion(dto, ana.id, ana.id),
    ]);

    expect(a.mensaje.id).toBe(b.mensaje.id);
    expect(await prisma.mensaje.count()).toBe(1);
    await esperarEnvios(1);
    await new Promise(r => setTimeout(r, 50));
    expect(envios).toHaveLength(1);
  });

  it('si la paciente ya tiene chat en esa línea, la plantilla entra en ese chat', async () => {
    const ana = await agente('ana', [RECEPCION]);
    await ingesta.procesarEntrante('+59170000002', 'Hola', 'wamid.1', 'Rosa', undefined, undefined, false, RECEPCION);
    const existente = await prisma.conversacion.findFirstOrThrow();
    const rosa = await prisma.cliente.findFirstOrThrow();

    const { conversacionId } = await service.iniciarConversacion(
      { lineaId: RECEPCION, clienteId: rosa.id, plantilla: 'saludo', idioma: 'es', parametros: [] },
      ana.id,
      ana.id,
    );

    expect(conversacionId).toBe(existente.id);
    expect(await prisma.conversacion.count()).toBe(1);
  });

  describe('lo que se rechaza no deja rastro', () => {
    async function sinRastro() {
      expect(await prisma.cliente.count()).toBe(0);
      expect(await prisma.conversacion.count()).toBe(0);
      expect(await prisma.mensaje.count()).toBe(0);
      expect(envios).toHaveLength(0);
    }

    it('una variable vacía', async () => {
      const ana = await agente('ana', [RECEPCION]);
      await expect(
        service.iniciarConversacion({ lineaId: RECEPCION, telefono: '70000003', ...seguimiento({ parametros: ['Lucía', ' '] }) }, ana.id, ana.id),
      ).rejects.toThrow('Falta completar «2»');
      await sinRastro();
    });

    it('una plantilla no aprobada', async () => {
      const ana = await agente('ana', [RECEPCION]);
      await expect(
        service.iniciarConversacion({ lineaId: RECEPCION, telefono: '70000003', plantilla: 'pendiente', idioma: 'es' }, ana.id, ana.id),
      ).rejects.toThrow('no está aprobada');
      await sinRastro();
    });

    it('un número que no es un teléfono', async () => {
      const ana = await agente('ana', [RECEPCION]);
      await expect(
        service.iniciarConversacion({ lineaId: RECEPCION, telefono: '12345678901234567', ...seguimiento() }, ana.id, ana.id),
      ).rejects.toThrow('no es un número de teléfono válido');
      await sinRastro();
    });

    it('una línea a la que no se tiene acceso', async () => {
      const ana = await agente('ana', [RECEPCION]);
      await expect(
        service.iniciarConversacion({ lineaId: VENTAS, telefono: '70000003', ...seguimiento() }, ana.id, ana.id),
      ).rejects.toThrow('Línea no encontrada');
      await sinRastro();
    });

    it('una línea sin conectar', async () => {
      const ana = await agente('ana', [DESCONECTADA]);
      await expect(
        service.iniciarConversacion({ lineaId: DESCONECTADA, telefono: '70000003', ...seguimiento() }, ana.id, ana.id),
      ).rejects.toThrow('no está conectada');
      await sinRastro();
    });
  });

  it('en la línea comercial no se le escribe a la paciente de otra agente', async () => {
    const ana = await agente('ana', [VENTAS]);
    const bea = await agente('bea', [VENTAS]);
    await prisma.cliente.create({ data: { nombre: 'Paciente de Bea', telefono: '+59170000004', agenteId: bea.id } });

    await expect(
      service.iniciarConversacion({ lineaId: VENTAS, telefono: '70000004', ...seguimiento() }, ana.id, ana.id),
    ).rejects.toThrow('la atiende otra agente');
    expect(await prisma.conversacion.count()).toBe(0);
    expect(envios).toHaveLength(0);
  });
});

describe('enviar una plantilla en un chat existente', () => {
  it('el historial guarda lo que recibió el paciente y Meta recibe los parámetros', async () => {
    const ana = await agente('ana', [RECEPCION]);
    await ingesta.procesarEntrante('+59170000005', 'Hola', 'wamid.5', 'Eva', undefined, undefined, false, RECEPCION);
    const conversacion = await prisma.conversacion.findFirstOrThrow();

    const mensaje = await service.enviarPlantilla(conversacion.id, seguimiento(), ana.id, ana.id);

    expect(mensaje.contenido).toContain('Hola Lucía');
    expect(mensaje.contenido).not.toContain('{{');
    await esperarEnvios(1);
    expect(envios[0]!.cuerpo).toMatchObject({
      type: 'template',
      template: {
        name: 'seguimiento',
        components: [{ type: 'body', parameters: [{ type: 'text', text: 'Lucía' }, { type: 'text', text: 'depilación láser' }] }],
      },
    });
  });
});
