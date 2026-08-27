import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AuditService } from '../../common/audit/audit.service';
import { R2Service } from '../../common/storage/r2.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientesService } from '../clientes/clientes.service';
import { ServiciosService } from '../servicios/servicios.service';
import { WhatsappCloudService } from '../../common/whatsapp/whatsapp-cloud.service';
import { ConversacionesGateway } from './conversaciones.gateway';
import { AcuseAutomaticoService } from './acuse-automatico.service';
import { DespachadorSalienteService } from './despachador-saliente.service';
import { ConversacionesService } from './conversaciones.service';
import { IngestaWhatsappService } from './ingesta-whatsapp.service';
import { MediaEntranteService } from './media-entrante.service';

/**
 * Pruebas contra un PostgreSQL DE VERDAD (`crm_test` en el :5433 local), con
 * Prisma real y SQL real. Nada de dobles para la base.
 *
 * El motivo es concreto: lo que hay que demostrar aquí lo decide Postgres, no
 * nuestro código. Que `updateMany ... where agenteId IS NULL` no le quite el
 * chat a nadie, que el `OR` de visibilidad devuelva las filas correctas, y que
 * dos webhooks simultáneos del mismo número creen UN cliente y no dos, son
 * cosas que solo se ven ejecutándolas. Una base falsa aceptaría igual una
 * consulta mal escrita.
 *
 * Lo único que sigue siendo un doble es lo que vive FUERA de este proceso y de
 * la base: Cloudflare R2 (red) y el emisor WebSocket. No hay forma de tenerlos
 * de verdad en una prueba, y no son lo que se está probando.
 *
 * Se ejecutan con `npm run test:integracion` (necesitan el Postgres arriba);
 * `npm test` las salta a propósito para que la suite rápida no dependa de una
 * base.
 */

const URL_TEST = 'postgresql://crm_app:crm_dev_local@localhost:5433/crm_test?schema=public';

/* Cerrojo: esta suite BORRA tablas enteras entre pruebas. Si alguna vez apunta
   a otra base que no sea la de pruebas, se niega a arrancar antes de tocar
   nada. Un test mal apuntado contra `crm` se lleva por delante 15.000 pacientes. */
if (!URL_TEST.includes('/crm_test')) {
  throw new Error('La suite de integración solo puede correr contra la base crm_test');
}

const prisma = new PrismaService({ datasources: { db: { url: URL_TEST } } });

/** Registra lo que se emitiría por WebSocket; no hay servidor de sockets aquí. */
class GatewayEspia {
  readonly emitidos: string[] = [];
  /** Solo lo que dispara notificación al teléfono — ver `notificarEntrante`. */
  readonly notificados: Array<{ conversacionId: string; agenteId?: string | null }> = [];

  emitirActividad(conversacionId: string): void {
    this.emitidos.push(conversacionId);
  }

  notificarEntrante(
    conversacionId: string,
    info: { clienteNombre?: string; texto?: string; agenteId?: string | null },
  ): void {
    this.emitirActividad(conversacionId);
    this.notificados.push({ conversacionId, agenteId: info.agenteId });
  }
}

/** R2 es Cloudflare por red; se registra lo que se subiría. */
class R2Espia {
  readonly subidos: Array<{ key: string; mime: string; bytes: number }> = [];
  habilitado = true;
  async subir(key: string, cuerpo: ArrayBuffer, mime: string): Promise<void> {
    this.subidos.push({ key, mime, bytes: cuerpo.byteLength });
  }
  async urlFirmada(key: string): Promise<string | null> {
    return `https://r2.local/${key}`;
  }
}

let service: ConversacionesService;
let ingesta: IngestaWhatsappService;
let clientesService: ClientesService;
let gateway: GatewayEspia;
let r2: R2Espia;

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  /* Orden inverso a las dependencias. `Conversacion` y `Lead` caen en cascada
     con `Cliente`, pero se borran explícitamente para no depender de eso. */
  await prisma.auditLog.deleteMany();
  await prisma.mensaje.deleteMany();
  await prisma.conversacion.deleteMany();
  await prisma.lead.deleteMany();
  await prisma.cliente.deleteMany();
  await prisma.usuario.deleteMany();

  gateway = new GatewayEspia();
  r2 = new R2Espia();
  /* ConfigService real y vacío: sin credenciales de Meta, los envíos a la Cloud
     API cortan antes del fetch. Es el comportamiento real documentado. */
  const config = new ConfigService({});
  clientesService = new ClientesService(prisma, new AuditService(prisma), new ServiciosService(prisma));
  const whatsappService = new WhatsappCloudService(config);
  /* Un solo despachador, compartido — igual que en producción, donde es un
     provider singleton que Nest inyecta en los dos services. */
  const despachadorService = new DespachadorSalienteService(
    prisma,
    gateway as unknown as ConversacionesGateway,
    r2 as unknown as R2Service,
    whatsappService,
  );
  service = new ConversacionesService(
    prisma,
    clientesService,
    gateway as unknown as ConversacionesGateway,
    r2 as unknown as R2Service,
    /* Sin credenciales queda deshabilitado: no sale ni una petición a Meta. */
    whatsappService,
    despachadorService,
  );
  ingesta = new IngestaWhatsappService(
    prisma,
    clientesService,
    gateway as unknown as ConversacionesGateway,
    new AcuseAutomaticoService(config),
    despachadorService,
    new MediaEntranteService(
      prisma,
      gateway as unknown as ConversacionesGateway,
      r2 as unknown as R2Service,
      whatsappService,
    ),
  );
  jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
  jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
  jest.spyOn(ingesta['logger'], 'error').mockImplementation(() => undefined);
});

async function crearAgente(nombre: string, rol: 'AGENTE' | 'ADMIN' = 'AGENTE') {
  return prisma.usuario.create({
    data: { nombre, email: `${nombre}@test.local`, passwordHash: 'x', rol, activo: true },
  });
}

async function crearChat(opciones: {
  telefono: string;
  agenteConversacion?: string | null;
  agenteCliente?: string | null;
}) {
  const cliente = await prisma.cliente.create({
    data: {
      nombre: `Paciente ${opciones.telefono}`,
      telefono: opciones.telefono,
      agenteId: opciones.agenteCliente ?? null,
    },
  });
  const conversacion = await prisma.conversacion.create({
    data: { clienteId: cliente.id, agenteId: opciones.agenteConversacion ?? null },
  });
  return { cliente, conversacion };
}

/**
 * `enviarMensaje` exige un ENTRANTE dentro de las últimas 24h (CSW de WhatsApp,
 * ver `verificarVentana24h`). `crearChat` no siembra ningún mensaje, así que
 * cualquier prueba que responda un chat recién creado necesita esto antes.
 */
async function crearMensajeEntrante(conversacionId: string, contenido = 'Hola, tengo una consulta'): Promise<void> {
  await prisma.mensaje.create({ data: { conversacionId, direccion: 'ENTRANTE', contenido } });
}

describe('Conversaciones contra Postgres real', () => {
  describe('visibilidad por rol', () => {
    it('el AGENTE ve las suyas, las del pool y las de sus clientes — y ninguna más', async () => {
      const a = await crearAgente('agente-a');
      const b = await crearAgente('agente-b');

      const suya = await crearChat({ telefono: '+59171000001', agenteConversacion: a.id });
      const pool = await crearChat({ telefono: '+59171000002' });
      const suCliente = await crearChat({
        telefono: '+59171000003',
        agenteConversacion: b.id,
        agenteCliente: a.id,
      });
      const ajena = await crearChat({
        telefono: '+59171000004',
        agenteConversacion: b.id,
        agenteCliente: b.id,
      });

      const visibles = (await service.findAll(a.id, a.id)).datos.map(c => c.id).sort();

      expect(visibles).toEqual([suya.conversacion.id, pool.conversacion.id, suCliente.conversacion.id].sort());
      expect(visibles).not.toContain(ajena.conversacion.id);
    });

    /**
     * El interruptor "Solo míos" es una preferencia de vista y el alcance por
     * rol es un permiso. Cuando compartían parámetro, hacer que el interruptor
     * del admin dijera "míos o del pool" le quitó a las agentes los chats de sus
     * propias pacientes. Estas dos pruebas son las que impiden volver a fundirlos.
     */
    describe('filtro "solo míos"', () => {
      it('acota la vista del ADMIN sin dejarle de mostrar el pool', async () => {
        const admin = await crearAgente('admin-a', 'ADMIN');
        const b = await crearAgente('agente-b');

        const suyo = await crearChat({ telefono: '+59171000011', agenteConversacion: admin.id });
        const pool = await crearChat({ telefono: '+59171000012' });
        const ajeno = await crearChat({
          telefono: '+59171000013',
          agenteConversacion: b.id,
          agenteCliente: b.id,
        });

        /* Un ADMIN no lleva alcance (ve todo); solo pide "míos". */
        const visibles = (await service.findAll(undefined, admin.id, { soloMios: true })).datos
          .map(c => c.id)
          .sort();

        expect(visibles).toEqual([suyo.conversacion.id, pool.conversacion.id].sort());
        expect(visibles).not.toContain(ajeno.conversacion.id);
      });

      it('nunca amplía lo que un AGENTE puede ver', async () => {
        const a = await crearAgente('agente-a');
        const b = await crearAgente('agente-b');

        const ajena = await crearChat({
          telefono: '+59171000014',
          agenteConversacion: b.id,
          agenteCliente: b.id,
        });

        /* Pedir "solo míos" con el id de otra no puede servir de puerta trasera:
           el permiso va por AND y sigue mandando. */
        const visibles = (await service.findAll(a.id, b.id, { soloMios: true })).datos.map(c => c.id);

        expect(visibles).not.toContain(ajena.conversacion.id);
      });
    });

    it('el ADMIN las ve todas', async () => {
      const b = await crearAgente('agente-b');
      await crearChat({ telefono: '+59171000001', agenteConversacion: b.id, agenteCliente: b.id });
      await crearChat({ telefono: '+59171000002' });

      expect((await service.findAll(undefined, b.id)).datos).toHaveLength(2);
    });

    /* Este es el desajuste que había: lo que el listado devuelve, el detalle
       tiene que dejarlo abrir. Se comprueba fila por fila, no de palabra. */
    it('todo lo que aparece en el listado se puede abrir sin 404', async () => {
      const a = await crearAgente('agente-a');
      const b = await crearAgente('agente-b');
      await crearChat({ telefono: '+59171000001', agenteConversacion: a.id });
      await crearChat({ telefono: '+59171000002' });
      await crearChat({ telefono: '+59171000003', agenteConversacion: b.id, agenteCliente: a.id });

      for (const c of (await service.findAll(a.id, a.id)).datos) {
        await expect(service.findOne(c.id, a.id)).resolves.toBeDefined();
      }
    });

    it('abrir por ID una conversación ajena da 404', async () => {
      const a = await crearAgente('agente-a');
      const b = await crearAgente('agente-b');
      const { conversacion } = await crearChat({
        telefono: '+59171000004',
        agenteConversacion: b.id,
        agenteCliente: b.id,
      });

      await expect(service.findOne(conversacion.id, a.id)).rejects.toThrow(NotFoundException);
    });
  });

  describe('responder no roba la conversación', () => {
    it('un ADMIN que contesta un chat ajeno NO se lo queda', async () => {
      const b = await crearAgente('agente-b');
      const admin = await crearAgente('jefa', 'ADMIN');
      const { conversacion } = await crearChat({ telefono: '+59171000005', agenteConversacion: b.id });
      await crearMensajeEntrante(conversacion.id);

      await service.enviarMensaje(conversacion.id, 'Reviso este caso', admin.id, undefined);

      const despues = await prisma.conversacion.findUniqueOrThrow({ where: { id: conversacion.id } });
      expect(despues.agenteId).toBe(b.id);
    });

    it('un chat del pool sí se asigna al que responde primero', async () => {
      const a = await crearAgente('agente-a');
      const { conversacion } = await crearChat({ telefono: '+59171000006' });
      await crearMensajeEntrante(conversacion.id);

      await service.enviarMensaje(conversacion.id, 'Hola, le atiendo', a.id, a.id);

      const despues = await prisma.conversacion.findUniqueOrThrow({ where: { id: conversacion.id } });
      expect(despues.agenteId).toBe(a.id);
    });

    /* Esto es lo que una base falsa no puede probar: el desempate lo hace
       Postgres, no nosotros. */
    it('si dos agentes contestan a la vez el mismo chat del pool, se lo lleva exactamente uno', async () => {
      const a = await crearAgente('agente-a');
      const b = await crearAgente('agente-b');
      const { conversacion } = await crearChat({ telefono: '+59171000007' });
      await crearMensajeEntrante(conversacion.id);

      await Promise.all([
        service.enviarMensaje(conversacion.id, 'yo lo tomo', a.id, a.id),
        service.enviarMensaje(conversacion.id, 'yo lo tomo', b.id, b.id),
      ]);

      const despues = await prisma.conversacion.findUniqueOrThrow({ where: { id: conversacion.id } });
      expect([a.id, b.id]).toContain(despues.agenteId);
      /* 3, no 2: el entrante sembrado para pasar la ventana de 24h + los dos salientes en pugna. */
      expect(await prisma.mensaje.count({ where: { conversacionId: conversacion.id } })).toBe(3);
    });

    /* Contestar reparte lo que no es de nadie, y NADA más. Esto decide de quién
       es la paciente, o sea quién cobra su comisión: si alguna de estas cuatro
       se pone roja, hay dinero cambiando de manos sin que nadie lo pida. */
    describe('contestar reclama a la paciente, pero solo si no tiene dueña', () => {
      it('un chat del pool: la paciente y sus leads abiertos pasan a quien contesta', async () => {
        const a = await crearAgente('agente-a');
        const { cliente, conversacion } = await crearChat({ telefono: '+59178000001' });
        const lead = await prisma.lead.create({
          data: { clienteId: cliente.id, origen: 'PRESENCIAL', estado: 'NUEVO' },
        });
        await crearMensajeEntrante(conversacion.id);

        await service.enviarMensaje(conversacion.id, 'le atiendo', a.id, a.id);

        expect((await prisma.cliente.findUniqueOrThrow({ where: { id: cliente.id } })).agenteId).toBe(a.id);
        expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).agenteId).toBe(a.id);
      });

      it('NO le quita la paciente a quien ya la tenía', async () => {
        const a = await crearAgente('agente-a');
        const b = await crearAgente('agente-b');
        const { cliente, conversacion } = await crearChat({
          telefono: '+59178000002',
          agenteCliente: b.id,
        });
        await crearMensajeEntrante(conversacion.id);

        await service.enviarMensaje(conversacion.id, 'contesto yo', a.id, a.id);

        expect((await prisma.cliente.findUniqueOrThrow({ where: { id: cliente.id } })).agenteId).toBe(b.id);
      });

      /* Un lead cerrado es histórico: por él se mide a la agente que lo trabajó
         en su momento, y contestar hoy no puede reescribirlo. */
      it('no toca los leads ya cerrados (CONVERTIDO / PERDIDO)', async () => {
        const a = await crearAgente('agente-a');
        const { cliente, conversacion } = await crearChat({ telefono: '+59178000003' });
        const perdido = await prisma.lead.create({
          data: { clienteId: cliente.id, origen: 'PRESENCIAL', estado: 'PERDIDO' },
        });
        const convertido = await prisma.lead.create({
          data: { clienteId: cliente.id, origen: 'PRESENCIAL', estado: 'CONVERTIDO' },
        });
        await crearMensajeEntrante(conversacion.id);

        await service.enviarMensaje(conversacion.id, 'hola', a.id, a.id);

        expect((await prisma.lead.findUniqueOrThrow({ where: { id: perdido.id } })).agenteId).toBeNull();
        expect((await prisma.lead.findUniqueOrThrow({ where: { id: convertido.id } })).agenteId).toBeNull();
      });

      it('queda auditado, porque cambia quién cobra', async () => {
        const a = await crearAgente('agente-a');
        const { cliente, conversacion } = await crearChat({ telefono: '+59178000004' });
        await crearMensajeEntrante(conversacion.id);

        await service.enviarMensaje(conversacion.id, 'hola', a.id, a.id);

        expect(
          await prisma.auditLog.count({
            where: { entidad: 'Cliente', entidadId: cliente.id, accion: 'AGENTE_RECLAMADO' },
          }),
        ).toBe(1);
      });

      it('contestar por segunda vez no vuelve a auditar', async () => {
        const a = await crearAgente('agente-a');
        const { cliente, conversacion } = await crearChat({ telefono: '+59178000005' });
        await crearMensajeEntrante(conversacion.id);

        await service.enviarMensaje(conversacion.id, 'uno', a.id, a.id);
        await service.enviarMensaje(conversacion.id, 'dos', a.id, a.id);

        expect(
          await prisma.auditLog.count({
            where: { entidad: 'Cliente', entidadId: cliente.id, accion: 'AGENTE_RECLAMADO' },
          }),
        ).toBe(1);
      });
    });

    it('el mensaje sube el chat al tope del inbox (updatedAt)', async () => {
      const a = await crearAgente('agente-a');
      const { conversacion } = await crearChat({ telefono: '+59171000008', agenteConversacion: a.id });
      await crearMensajeEntrante(conversacion.id);
      const antes = conversacion.updatedAt;

      await new Promise(r => setTimeout(r, 5));
      await service.enviarMensaje(conversacion.id, 'hola', a.id, a.id);

      const despues = await prisma.conversacion.findUniqueOrThrow({ where: { id: conversacion.id } });
      expect(despues.updatedAt.getTime()).toBeGreaterThan(antes.getTime());
    });
  });

  describe('asignarAgente arrastra cliente y leads, y queda auditado', () => {
    it('reasigna en cascada sin que este módulo escriba en tablas ajenas', async () => {
      const a = await crearAgente('agente-a');
      const b = await crearAgente('agente-b');
      const { cliente, conversacion } = await crearChat({
        telefono: '+59171000009',
        agenteConversacion: a.id,
        agenteCliente: a.id,
      });
      await prisma.lead.create({
        data: { clienteId: cliente.id, origen: 'WHATSAPP_DIRECTO', estado: 'NUEVO', agenteId: a.id },
      });

      await service.asignarAgente(conversacion.id, b.id, 'usuario-admin');

      expect((await prisma.conversacion.findUniqueOrThrow({ where: { id: conversacion.id } })).agenteId).toBe(b.id);
      expect((await prisma.cliente.findUniqueOrThrow({ where: { id: cliente.id } })).agenteId).toBe(b.id);
      expect(await prisma.lead.count({ where: { clienteId: cliente.id, agenteId: b.id } })).toBe(1);
    });

    it('deja rastro en AuditLog de quién reasignó', async () => {
      const a = await crearAgente('agente-a');
      const { cliente, conversacion } = await crearChat({ telefono: '+59171000010', agenteCliente: a.id });

      await service.asignarAgente(conversacion.id, null, 'usuario-admin');

      const registros = await prisma.auditLog.findMany({ where: { entidadId: cliente.id } });
      expect(registros).toHaveLength(1);
      expect(registros[0].usuarioId).toBe('usuario-admin');
    });

    it('desasignar devuelve cliente y chat al pool', async () => {
      const a = await crearAgente('agente-a');
      const { cliente, conversacion } = await crearChat({
        telefono: '+59171000011',
        agenteConversacion: a.id,
        agenteCliente: a.id,
      });

      await service.asignarAgente(conversacion.id, null, 'usuario-admin');

      expect((await prisma.conversacion.findUniqueOrThrow({ where: { id: conversacion.id } })).agenteId).toBeNull();
      expect((await prisma.cliente.findUniqueOrThrow({ where: { id: cliente.id } })).agenteId).toBeNull();
    });
  });

  describe('webhook entrante: alta automática e idempotencia', () => {
    it('un mensaje de un número nuevo crea cliente, conversación y lead', async () => {
      await ingesta.procesarEntrante('+59172000001', 'Hola, quiero información', 'wamid.a1', 'Ana Pérez');

      const cliente = await prisma.cliente.findUniqueOrThrow({ where: { telefono: '+59172000001' } });
      expect(cliente.nombre).toBe('Ana Pérez');
      expect(await prisma.conversacion.count({ where: { clienteId: cliente.id } })).toBe(1);
      expect(await prisma.lead.count({ where: { clienteId: cliente.id } })).toBe(1);
    });

    it('el mismo whatsappMsgId dos veces guarda UN mensaje (Meta reintenta)', async () => {
      await ingesta.procesarEntrante('+59172000002', 'Hola', 'wamid.b1');
      await ingesta.procesarEntrante('+59172000002', 'Hola', 'wamid.b1');

      expect(await prisma.mensaje.count({ where: { whatsappMsgId: 'wamid.b1' } })).toBe(1);
    });

    /* La prueba que pide el propio manual del proyecto: N webhooks en paralelo
       del mismo número deben dar 1 cliente / 1 conversación / N mensajes / 1 lead.
       Con `findFirst → create` esto creaba duplicados o reventaba con P2002. */
    it('5 webhooks simultáneos del mismo número nuevo: 1 cliente, 1 conversación, 5 mensajes, 1 lead', async () => {
      await Promise.all(
        [1, 2, 3, 4, 5].map(n =>
          ingesta.procesarEntrante('+59172000003', `mensaje ${n}`, `wamid.c${n}`, 'Paciente Nuevo'),
        ),
      );

      const cliente = await prisma.cliente.findUniqueOrThrow({ where: { telefono: '+59172000003' } });
      expect(await prisma.cliente.count({ where: { telefono: '+59172000003' } })).toBe(1);
      expect(await prisma.conversacion.count({ where: { clienteId: cliente.id } })).toBe(1);
      expect(await prisma.mensaje.count()).toBe(5);
      expect(await prisma.lead.count({ where: { clienteId: cliente.id } })).toBe(1);
    });

    it('un entrante sube el chat al tope del inbox', async () => {
      await ingesta.procesarEntrante('+59172000004', 'primero', 'wamid.d1');
      const conv = await prisma.conversacion.findFirstOrThrow();
      const antes = conv.updatedAt;

      await new Promise(r => setTimeout(r, 5));
      await ingesta.procesarEntrante('+59172000004', 'segundo', 'wamid.d2');

      const despues = await prisma.conversacion.findUniqueOrThrow({ where: { id: conv.id } });
      expect(despues.updatedAt.getTime()).toBeGreaterThan(antes.getTime());
    });

    it('sin nombre de perfil, el alta usa el marcador con el teléfono', async () => {
      await ingesta.procesarEntrante('+59172000005', 'Hola', 'wamid.e1');
      const cliente = await prisma.cliente.findUniqueOrThrow({ where: { telefono: '+59172000005' } });
      expect(cliente.nombre).toBe('WhatsApp +59172000005');
    });
  });

  /**
   * Click-to-WhatsApp: varias pacientes entran por el MISMO anuncio.
   *
   * Es el caso normal de una campaña —para eso se paga— y era el que fallaba:
   * el id del anuncio se guardaba en `Lead.metaLeadId`, que es `@unique` porque
   * ahí va el `leadgen_id` de Lead Ads, uno por persona. La primera paciente
   * creaba su lead y la segunda reventaba con P2002.
   *
   * Y el daño no se quedaba en el lead: la excepción salía de `procesarEntrante`
   * sin try/catch, así que se llevaba por delante lo que viene después —el aviso
   * push a la agente y el acuse fuera de horario—. En plena campaña, de la
   * segunda paciente en adelante nadie se enteraba de que había escrito.
   *
   * Probar con UNA sola paciente por anuncio pasaba en verde, que es justo por
   * lo que el fallo llegó a producción sin verse.
   */
  describe('Click-to-WhatsApp: varias pacientes por el mismo anuncio', () => {
    const anuncio = '120215839201920';
    const campana = { origenTipo: 'ad', anuncioId: anuncio, titular: 'Promo Rinoplastia' };

    it('dos pacientes del mismo anuncio generan sus dos leads', async () => {
      await ingesta.procesarEntrante('+59172000020', 'Hola', 'wamid.ads1', 'Primera', undefined, campana);
      await ingesta.procesarEntrante('+59172000021', 'Hola', 'wamid.ads2', 'Segunda', undefined, campana);

      const leads = await prisma.lead.findMany({ where: { anuncioId: anuncio } });
      expect(leads).toHaveLength(2);
      /* El anuncio va a su columna; `metaLeadId` queda libre para Lead Ads. */
      expect(leads.every(l => l.metaLeadId === null)).toBe(true);
      expect(leads.every(l => l.origen === 'FACEBOOK_LEAD_AD')).toBe(true);
    });

    /* Lo que de verdad dolía: la segunda paciente escribía y no sonaba nada.
       La excepción del lead cortaba `procesarEntrante` justo antes de
       `notificarEntrante`, así que este contador se quedaba en 1. */
    it('la segunda paciente del anuncio también dispara su aviso al teléfono', async () => {
      await ingesta.procesarEntrante('+59172000022', 'Hola', 'wamid.ads3', 'Primera', undefined, campana);
      await ingesta.procesarEntrante('+59172000023', 'Hola', 'wamid.ads4', 'Segunda', undefined, campana);

      expect(gateway.notificados).toHaveLength(2);
    });

    it('un anuncio de Instagram se clasifica como INSTAGRAM_LEAD_AD', async () => {
      await ingesta.procesarEntrante('+59172000024', 'Hola', 'wamid.ads5', 'Tercera', undefined, {
        ...campana,
        origenUrl: 'https://www.instagram.com/p/xyz',
      });

      const lead = await prisma.lead.findFirstOrThrow({ where: { anuncioId: anuncio } });
      expect(lead.origen).toBe('INSTAGRAM_LEAD_AD');
    });

    /* Sin `referral` nada cambia: el chat orgánico sigue siendo WHATSAPP_DIRECTO
       y sin anuncio, para que la atribución de campaña no se contamine. */
    it('un chat orgánico no queda atribuido a ninguna campaña', async () => {
      await ingesta.procesarEntrante('+59172000025', 'Hola', 'wamid.org1', 'Orgánica');

      const lead = await prisma.lead.findFirstOrThrow({
        where: { cliente: { telefono: '+59172000025' } },
      });
      expect(lead.anuncioId).toBeNull();
      expect(lead.origen).toBe('WHATSAPP_DIRECTO');
    });
  });

  /**
   * El refresco por WebSocket es barato y lo dispara todo; la notificación al
   * teléfono es intrusiva y solo la dispara un mensaje de la paciente.
   *
   * Estaban unidos, y como los ocho puntos que refrescan el inbox pasaban por
   * el mismo método, cada tilde de entrega de Meta y cada envío de la propia
   * agente sonaban en todos los teléfonos — incluido el acuse automático de
   * madrugada. Una notificación que suena sin motivo se desactiva, y entonces
   * tampoco suena la que importa.
   */
  describe('a quién se le avisa al teléfono', () => {
    it('un mensaje de la paciente notifica una sola vez', async () => {
      await ingesta.procesarEntrante('+59172000010', 'Hola, quiero una cita', 'wamid.n1');

      expect(gateway.notificados).toHaveLength(1);
    });

    it('el chat sin dueña notifica al equipo entero', async () => {
      await ingesta.procesarEntrante('+59172000011', 'Hola', 'wamid.n2');

      expect(gateway.notificados[0].agenteId).toBeNull();
    });

    it('con dueña, el aviso lleva su id', async () => {
      const a = await crearAgente('agente-a');
      await crearChat({ telefono: '+59172000012', agenteCliente: a.id });

      await ingesta.procesarEntrante('+59172000012', 'Hola', 'wamid.n3');

      expect(gateway.notificados[0].agenteId).toBe(a.id);
    });

    /**
     * `enviarMensaje` despacha a Meta con `void` —la agente no espera el viaje
     * de red—, así que vuelve antes de que el envío termine. Si la prueba acaba
     * ahí, el `beforeEach` borra los mensajes y el despacho en vuelo intenta
     * actualizar una fila que ya no existe: la prueba SIGUIENTE revienta con un
     * error que no tiene nada que ver con ella.
     *
     * Sin credenciales de Meta el envío corta antes del fetch y el mensaje queda
     * FALLIDO; esperar a ese estado es esperar a que el trabajo en segundo plano
     * haya terminado de verdad.
     */
    async function esperarDespacho(mensajeId: string, msMax = 2000): Promise<void> {
      const limite = Date.now() + msMax;
      while (Date.now() < limite) {
        const m = await prisma.mensaje.findUnique({ where: { id: mensajeId } });
        if (m?.estadoEnvio === 'FALLIDO') return;
        await new Promise(r => setTimeout(r, 25));
      }
    }

    it('que responda la agente refresca el inbox pero NO notifica a nadie', async () => {
      const a = await crearAgente('agente-a');
      const chat = await crearChat({ telefono: '+59172000013', agenteConversacion: a.id });
      await crearMensajeEntrante(chat.conversacion.id);

      const enviado = await service.enviarMensaje(chat.conversacion.id, 'Buenas tardes', a.id);
      await esperarDespacho(enviado.id);

      expect(gateway.emitidos).toContain(chat.conversacion.id);
      expect(gateway.notificados).toHaveLength(0);
    });

    it('una tilde de entrega de Meta no notifica a nadie', async () => {
      const a = await crearAgente('agente-a');
      const chat = await crearChat({ telefono: '+59172000014', agenteConversacion: a.id });
      await prisma.mensaje.create({
        data: {
          conversacionId: chat.conversacion.id,
          direccion: 'SALIENTE',
          contenido: 'Hola',
          estadoEnvio: 'ENVIADO',
          whatsappMsgId: 'wamid.tick1',
        },
      });

      await service.procesarEstadoMensaje('wamid.tick1', 'read');

      expect(gateway.emitidos).toContain(chat.conversacion.id);
      expect(gateway.notificados).toHaveLength(0);
    });
  });

  describe('estados de entrega (ticks)', () => {
    async function mensajeSaliente(estado: 'ENVIADO' | 'ENTREGADO' | 'LEIDO') {
      const a = await crearAgente('agente-a');
      const { conversacion } = await crearChat({ telefono: '+59173000001', agenteConversacion: a.id });
      return prisma.mensaje.create({
        data: {
          conversacionId: conversacion.id,
          direccion: 'SALIENTE',
          contenido: 'hola',
          estadoEnvio: estado,
          whatsappMsgId: 'wamid.out.1',
        },
      });
    }

    it('sent → delivered → read avanza', async () => {
      const m = await mensajeSaliente('ENVIADO');
      await service.procesarEstadoMensaje('wamid.out.1', 'delivered');
      expect((await prisma.mensaje.findUniqueOrThrow({ where: { id: m.id } })).estadoEnvio).toBe('ENTREGADO');

      await service.procesarEstadoMensaje('wamid.out.1', 'read');
      expect((await prisma.mensaje.findUniqueOrThrow({ where: { id: m.id } })).estadoEnvio).toBe('LEIDO');
    });

    it('un delivered que llega tarde NO pisa un read anterior', async () => {
      const m = await mensajeSaliente('LEIDO');
      await service.procesarEstadoMensaje('wamid.out.1', 'delivered');
      expect((await prisma.mensaje.findUniqueOrThrow({ where: { id: m.id } })).estadoEnvio).toBe('LEIDO');
    });

    it('un status de un mensaje desconocido no revienta', async () => {
      await expect(service.procesarEstadoMensaje('wamid.inexistente', 'read')).resolves.toBeUndefined();
    });
  });

  describe('marcar leído', () => {
    it('pone leidoEn a los entrantes sin leer y vacía el contador del inbox', async () => {
      const a = await crearAgente('agente-a');
      await ingesta.procesarEntrante('+59174000001', 'uno', 'wamid.f1');
      await ingesta.procesarEntrante('+59174000001', 'dos', 'wamid.f2');
      const conv = await prisma.conversacion.findFirstOrThrow();
      await prisma.conversacion.update({ where: { id: conv.id }, data: { agenteId: a.id } });

      expect((await service.findAll(a.id, a.id)).datos[0].noLeidosCount).toBe(2);

      await service.marcarLeido(conv.id, a.id, false);

      expect(await prisma.mensaje.count({ where: { direccion: 'ENTRANTE', leidoEn: null } })).toBe(0);
      expect((await service.findAll(a.id, a.id)).datos[0].noLeidosCount).toBe(0);
    });

    it('no marca nada si la conversación es de otro agente', async () => {
      const a = await crearAgente('agente-a');
      const b = await crearAgente('agente-b');
      await ingesta.procesarEntrante('+59174000002', 'uno', 'wamid.g1');
      const conv = await prisma.conversacion.findFirstOrThrow();
      await prisma.conversacion.update({ where: { id: conv.id }, data: { agenteId: b.id } });
      await prisma.cliente.updateMany({ data: { agenteId: b.id } });

      expect(await service.marcarLeido(conv.id, a.id, false)).toEqual({ ok: false });
      expect(await prisma.mensaje.count({ where: { direccion: 'ENTRANTE', leidoEn: null } })).toBe(1);
    });
  });

  describe('mensajes anteriores (scroll hacia arriba)', () => {
    it('devuelve solo los previos al cursor, en orden ascendente', async () => {
      const a = await crearAgente('agente-a');
      const { conversacion } = await crearChat({ telefono: '+59175000001', agenteConversacion: a.id });
      for (let i = 1; i <= 5; i++) {
        await prisma.mensaje.create({
          data: {
            conversacionId: conversacion.id,
            direccion: 'ENTRANTE',
            contenido: `msg ${i}`,
            createdAt: new Date(`2026-08-0${i}T10:00:00.000Z`),
          },
        });
      }

      const previos = await service.obtenerMensajesAnteriores(
        conversacion.id,
        '2026-08-04T00:00:00.000Z',
        50,
        a.id,
      );

      expect(previos.map(m => m.contenido)).toEqual(['msg 1', 'msg 2', 'msg 3']);
    });

    it('exige poder ver la conversación', async () => {
      const a = await crearAgente('agente-a');
      const b = await crearAgente('agente-b');
      const { conversacion } = await crearChat({
        telefono: '+59175000002',
        agenteConversacion: b.id,
        agenteCliente: b.id,
      });

      await expect(
        service.obtenerMensajesAnteriores(conversacion.id, '2026-08-04T00:00:00.000Z', 50, a.id),
      ).rejects.toThrow(NotFoundException);
    });
  });

  /**
   * `Conversacion.esperandoRespuesta` es la pestaña "Sin responder", y está
   * desnormalizado: no se deduce del último mensaje al leer, se ESCRIBE al
   * crearlo. Eso lo vuelve rápido y filtrable en SQL —que es lo que permitió
   * quitar el tope de 500— a cambio de una regla que hay que sostener: los
   * cuatro caminos que crean un Mensaje tienen que dejarlo bien.
   *
   * Estas cuatro pruebas son ese contrato. Si alguien agrega un quinto camino y
   * se olvida del campo, la pestaña miente en silencio: una paciente esperando
   * que no aparece, o una ya atendida que sí. Ninguna de las dos se nota
   * mirando la pantalla.
   */
  describe('la pestaña "Sin responder" se mantiene al crear cada mensaje', () => {
    async function esperandoRespuestaDe(conversacionId: string): Promise<boolean> {
      const c = await prisma.conversacion.findUniqueOrThrow({ where: { id: conversacionId } });
      return c.esperandoRespuesta;
    }

    it('un mensaje ENTRANTE la deja esperando', async () => {
      await ingesta.procesarEntrante('+59173000001', 'Hola, quiero información', 'wamid.e1');
      const conv = await prisma.conversacion.findFirstOrThrow();

      expect(await esperandoRespuestaDe(conv.id)).toBe(true);
    });

    it('que responda una persona la saca de la pestaña', async () => {
      const a = await crearAgente('agente-a');
      await ingesta.procesarEntrante('+59173000002', 'Hola', 'wamid.e2');
      const conv = await prisma.conversacion.findFirstOrThrow();

      await service.enviarMensaje(conv.id, 'Buenas, le ayudo', a.id);

      expect(await esperandoRespuestaDe(conv.id)).toBe(false);
    });

    it('una plantilla también cuenta como respuesta', async () => {
      const a = await crearAgente('agente-a');
      await ingesta.procesarEntrante('+59173000003', 'Hola', 'wamid.e3');
      const conv = await prisma.conversacion.findFirstOrThrow();

      await service.enviarPlantilla(
        conv.id,
        { plantilla: 'saludo', idioma: 'es', parametros: [], contenido: 'Buenas tardes' },
        a.id,
      );

      expect(await esperandoRespuestaDe(conv.id)).toBe(false);
    });

    /* El cuarto camino —el acuse automático fuera de horario— se prueba en el
       bloque de más abajo, que es el único que tiene el reloj falso necesario
       para que la clínica esté cerrada: "un domingo, el acuse deja la
       conversación esperando igual". */
  });

describe('Acuse automático fuera de horario', () => {
  /** Domingo: la clínica abre L-V y sábado por la mañana. */
  const DOMINGO = new Date('2026-08-09T18:00:00Z');
  /** Martes 10:00 en Bolivia. */
  const MARTES = new Date('2026-08-11T14:00:00Z');

  function conConfig(extra: Record<string, string> = {}) {
    const valores: Record<string, string> = {
      AUTORESPUESTA_TEXTO: 'Mensaje automático. Urgencias: 700-00000.',
      AUTORESPUESTA_HORARIO: 'L-V:08:00-18:00,S:08:00-12:00',
      AUTORESPUESTA_ZONA: 'America/La_Paz',
      ...extra,
    };
    return new ConfigService(valores);
  }

  /**
   * Solo construye `IngestaWhatsappService` — es la única que necesita el
   * reloj sustituido (`ahora()` vive ahí desde el split; ver ese archivo).
   * Donde una prueba de este bloque necesita leer el inbox (`findAll`), usa
   * el `service` del `beforeEach` de arriba: esa lectura no depende de la
   * hora, así que no hace falta una segunda instancia de ConversacionesService
   * por cada combinación de horario que se prueba aquí.
   */
  function servicioCon(config: ConfigService, ahora: Date) {
    const whatsapp = new WhatsappCloudService(config);
    const s = new IngestaWhatsappService(
      prisma,
      clientesService,
      gateway as unknown as ConversacionesGateway,
      new AcuseAutomaticoService(config),
      new DespachadorSalienteService(
        prisma,
        gateway as unknown as ConversacionesGateway,
        r2 as unknown as R2Service,
        whatsapp,
      ),
      new MediaEntranteService(
        prisma,
        gateway as unknown as ConversacionesGateway,
        r2 as unknown as R2Service,
        whatsapp,
      ),
    );
    /* Se sustituye el reloj en vez de congelar los temporizadores: los fake
       timers de Jest paran también los que Prisma usa por dentro. */
    jest.spyOn(s as unknown as { ahora(): Date }, 'ahora').mockReturnValue(ahora);
    jest.spyOn(s['logger'], 'error').mockImplementation(() => undefined);
    return s;
  }

  /**
   * El acuse se dispara con `void` —el webhook debe responder en milisegundos—,
   * así que `procesarEntrante` vuelve antes de que exista el mensaje. Se espera
   * a que aparezca en vez de hacer awaitable el método: así la prueba recorre
   * el mismo camino que producción, fire-and-forget incluido.
   */
  async function esperarSalientes(cuantos: number, msMax = 2000): Promise<number> {
    const limite = Date.now() + msMax;
    let total = 0;
    while (Date.now() < limite) {
      total = await prisma.mensaje.count({ where: { direccion: 'SALIENTE' } });
      if (total >= cuantos) return total;
      await new Promise(r => setTimeout(r, 25));
    }
    return total;
  }

  it('un domingo responde una vez y la marca como automática', async () => {
    const s = servicioCon(conConfig(), DOMINGO);
    await s.procesarEntrante('+59176000001', 'Hola, quiero una cita', 'wamid.d1');
    await esperarSalientes(1);

    const enviados = await prisma.mensaje.findMany({ where: { direccion: 'SALIENTE' } });
    expect(enviados).toHaveLength(1);
    expect(enviados[0].automatico).toBe(true);
    expect(enviados[0].contenido).toContain('Urgencias');
  });

  /**
   * El cuarto camino de escritura de `esperandoRespuesta` (ver el contrato en
   * "la pestaña Sin responder se mantiene al crear cada mensaje").
   *
   * El acuse es SALIENTE pero NO es una respuesta. Si lo contara como tal, todo
   * lo que entra un fin de semana saldría de la pestaña y el lunes nadie sabría
   * quién quedó esperando — que es justo lo que la marca `automatico` existe
   * para evitar en `estaSinResponder()`.
   */
  it('el acuse del domingo deja la conversación esperando igual', async () => {
    const s = servicioCon(conConfig(), DOMINGO);
    await s.procesarEntrante('+59176000010', 'Hola', 'wamid.d10');
    await esperarSalientes(1);

    const conv = await prisma.conversacion.findFirstOrThrow();
    expect(conv.esperandoRespuesta).toBe(true);
  });

  it('en horario de atención no responde nada', async () => {
    const s = servicioCon(conConfig(), MARTES);
    await s.procesarEntrante('+59176000002', 'Hola', 'wamid.m1');

    expect(await prisma.mensaje.count({ where: { direccion: 'SALIENTE' } })).toBe(0);
  });

  /* Cinco mensajes seguidos no pueden dar cinco acuses: se lee como un sistema
     roto y molesta a quien ya está esperando. */
  it('varios mensajes seguidos reciben UN solo acuse', async () => {
    const s = servicioCon(conConfig(), DOMINGO);
    for (const n of [1, 2, 3, 4, 5]) {
      await s.procesarEntrante('+59176000003', `mensaje ${n}`, `wamid.r${n}`);
    }
    await esperarSalientes(1);

    expect(await prisma.mensaje.count({ where: { direccion: 'ENTRANTE' } })).toBe(5);
    expect(await prisma.mensaje.count({ where: { direccion: 'SALIENTE' } })).toBe(1);
  });

  /**
   * La razón de ser del campo `automatico`. El inbox marca "sin responder"
   * mirando el ÚLTIMO mensaje: si el acuse contara como respuesta, todas las
   * conversaciones del fin de semana desaparecerían de esa pestaña y el lunes
   * nadie sabría quién escribió.
   */
  it('el acuse no hace que la conversación parezca contestada', async () => {
    const s = servicioCon(conConfig(), DOMINGO);
    await s.procesarEntrante('+59176000004', 'Hola', 'wamid.s1');
    await esperarSalientes(1);

    const [conv] = (await service.findAll(undefined, 'admin-cualquiera')).datos;
    const ultimo = conv.mensajes[0];

    expect(ultimo.direccion).toBe('SALIENTE');
    expect(ultimo.automatico).toBe(true); // el frontend lo usa para no darla por atendida
  });

  it('sin texto configurado no envía nada, aunque esté cerrado', async () => {
    const s = servicioCon(conConfig({ AUTORESPUESTA_TEXTO: '' }), DOMINGO);
    await s.procesarEntrante('+59176000005', 'Hola', 'wamid.v1');

    expect(await prisma.mensaje.count({ where: { direccion: 'SALIENTE' } })).toBe(0);
  });

  /* Un horario mal escrito debe callar, no contestar "estamos cerrados" a
     cualquier hora. */
  it('con el horario mal escrito no envía nada', async () => {
    const s = servicioCon(conConfig({ AUTORESPUESTA_HORARIO: 'esto no es un horario' }), DOMINGO);
    await s.procesarEntrante('+59176000006', 'Hola', 'wamid.w1');

    expect(await prisma.mensaje.count({ where: { direccion: 'SALIENTE' } })).toBe(0);
  });

  it('el mensaje del paciente se guarda aunque el acuse falle', async () => {
    const s = servicioCon(conConfig({ AUTORESPUESTA_ESPERA_HORAS: 'x' }), DOMINGO);
    await s.procesarEntrante('+59176000007', 'Hola', 'wamid.x1');

    expect(await prisma.mensaje.count({ where: { whatsappMsgId: 'wamid.x1' } })).toBe(1);
  });

  /**
   * Hasta este cambio, un clic en el botón del acuse no disparaba nada más:
   * el título quedaba en el chat como si el paciente lo hubiera escrito.
   */
  describe('pedido de nombre y edad tras un clic en el botón del acuse', () => {
    it('un clic dispara el pedido, marcado como automático', async () => {
      const s = servicioCon(
        conConfig({ AUTORESPUESTA_PEDIDO_DATOS: 'Decinos tu nombre y edad, porfa.' }),
        DOMINGO,
      );
      await s.procesarEntrante('+59176000008', 'Hola', 'wamid.p0'); // dispara el acuse normal
      await esperarSalientes(1);

      await s.procesarEntrante(
        '+59176000008',
        'Agendar una cita', // el título del botón, tal como vuelve por el webhook
        'wamid.p1',
        undefined,
        undefined,
        undefined,
        true, // esRespuestaBotonAcuse
      );
      await esperarSalientes(2);

      const salientes = await prisma.mensaje.findMany({
        where: { direccion: 'SALIENTE' },
        orderBy: { createdAt: 'asc' },
      });
      expect(salientes).toHaveLength(2);
      expect(salientes[1].contenido).toBe('Decinos tu nombre y edad, porfa.');
      expect(salientes[1].automatico).toBe(true);
    });

    it('un mensaje normal (no un clic) no dispara el pedido', async () => {
      const s = servicioCon(
        conConfig({ AUTORESPUESTA_PEDIDO_DATOS: 'Decinos tu nombre y edad, porfa.' }),
        DOMINGO,
      );
      await s.procesarEntrante('+59176000009', 'Agendar una cita', 'wamid.q0'); // sin el flag: es texto normal
      await esperarSalientes(1);

      await new Promise(r => setTimeout(r, 300));
      expect(await prisma.mensaje.count({ where: { direccion: 'SALIENTE' } })).toBe(1); // solo el acuse
    });

    it('no se repite si el paciente clica un segundo botón', async () => {
      const s = servicioCon(
        conConfig({ AUTORESPUESTA_PEDIDO_DATOS: 'Decinos tu nombre y edad, porfa.' }),
        DOMINGO,
      );
      await s.procesarEntrante('+59176000010', 'Hola', 'wamid.r0');
      await esperarSalientes(1);
      await s.procesarEntrante('+59176000010', 'Agendar una cita', 'wamid.r1', undefined, undefined, undefined, true);
      await esperarSalientes(2);
      await s.procesarEntrante('+59176000010', 'Ver resultados', 'wamid.r2', undefined, undefined, undefined, true);

      await new Promise(r => setTimeout(r, 300));
      expect(await prisma.mensaje.count({ where: { direccion: 'SALIENTE' } })).toBe(2); // no un tercero
    });

    it('sin AUTORESPUESTA_PEDIDO_DATOS configurado, el clic no manda nada extra', async () => {
      const s = servicioCon(conConfig(), DOMINGO); // sin la variable nueva
      await s.procesarEntrante('+59176000011', 'Hola', 'wamid.s0');
      await esperarSalientes(1);
      await s.procesarEntrante('+59176000011', 'Agendar una cita', 'wamid.s1', undefined, undefined, undefined, true);

      await new Promise(r => setTimeout(r, 300));
      expect(await prisma.mensaje.count({ where: { direccion: 'SALIENTE' } })).toBe(1);
    });
  });
});

describe('búsqueda histórica de mensajes', () => {
  /** Deja un chat de `duena` con tres mensajes, dos de los cuales dicen "botox". */
  async function chatConHistorial(duena: string, telefono: string) {
    const { conversacion } = await crearChat({
      telefono,
      agenteConversacion: duena,
      agenteCliente: duena,
    });
    for (const [i, contenido] of ['Quiero BOTOX', 'precio del botox?', 'gracias'].entries()) {
      await prisma.mensaje.create({
        data: {
          conversacionId: conversacion.id,
          direccion: 'ENTRANTE',
          contenido,
          whatsappMsgId: `wamid.busca.${telefono}.${i}`,
        },
      });
    }
    return conversacion;
  }

  it('encuentra sin importar mayúsculas y no trae lo que no coincide', async () => {
    const a = await crearAgente('agente-a');
    const conversacion = await chatConHistorial(a.id, '+59177000001');

    const { total, items } = await service.buscarMensajes(conversacion.id, 'botox', 20, 0, a.id);

    expect(total).toBe(2);
    expect(items.map(m => m.contenido).sort()).toEqual(['Quiero BOTOX', 'precio del botox?']);
  });

  /* La razón de ser del escopado: el id de una conversación viaja en la URL, así
     que sin el filtro por agente el buscador es una puerta lateral para leer el
     historial de la paciente de otra — justo lo que `findOne` ya impide. */
  it('buscar en una conversación ajena da 404 en vez de resultados', async () => {
    const a = await crearAgente('agente-a');
    const b = await crearAgente('agente-b');
    const conversacion = await chatConHistorial(b.id, '+59177000002');

    await expect(service.buscarMensajes(conversacion.id, 'botox', 20, 0, a.id)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('el ADMIN sí busca en cualquier chat', async () => {
    const b = await crearAgente('agente-b');
    const conversacion = await chatConHistorial(b.id, '+59177000003');

    expect((await service.buscarMensajes(conversacion.id, 'botox', 20, 0)).total).toBe(2);
  });

  it('pagina: el total es del historial completo, no de la página', async () => {
    const a = await crearAgente('agente-a');
    const conversacion = await chatConHistorial(a.id, '+59177000004');

    const primera = await service.buscarMensajes(conversacion.id, 'botox', 1, 0, a.id);
    const segunda = await service.buscarMensajes(conversacion.id, 'botox', 1, 1, a.id);

    expect(primera.total).toBe(2);
    expect(primera.items).toHaveLength(1);
    expect(segunda.items[0].id).not.toBe(primera.items[0].id);
  });

  it('un término en blanco no devuelve el historial entero', async () => {
    const a = await crearAgente('agente-a');
    const conversacion = await chatConHistorial(a.id, '+59177000005');

    expect(await service.buscarMensajes(conversacion.id, '   ', 20, 0, a.id)).toEqual({
      total: 0,
      items: [],
    });
  });

  /* Prisma NO escapa los comodines de LIKE: sin `escaparComodinesLike`, buscar
     "%" devolvía el hilo entero. Aquí se comprobó, no se supuso. */
  it('un % no actúa como comodín', async () => {
    const a = await crearAgente('agente-a');
    const conversacion = await chatConHistorial(a.id, '+59177000006');

    expect((await service.buscarMensajes(conversacion.id, '%', 20, 0, a.id)).total).toBe(0);
  });

  it('busca un descuento con % literal sin traer de más', async () => {
    const a = await crearAgente('agente-a');
    const { conversacion } = await crearChat({
      telefono: '+59177000007',
      agenteConversacion: a.id,
      agenteCliente: a.id,
    });
    for (const [i, contenido] of ['tienen 20% de descuento?', 'son 20 sesiones'].entries()) {
      await prisma.mensaje.create({
        data: {
          conversacionId: conversacion.id,
          direccion: 'ENTRANTE',
          contenido,
          whatsappMsgId: `wamid.desc.${i}`,
        },
      });
    }

    const { total, items } = await service.buscarMensajes(conversacion.id, '20%', 20, 0, a.id);

    expect(total).toBe(1);
    expect(items[0].contenido).toBe('tienen 20% de descuento?');
  });

  it('el guion bajo tampoco es comodín', async () => {
    const a = await crearAgente('agente-a');
    const conversacion = await chatConHistorial(a.id, '+59177000008');

    expect((await service.buscarMensajes(conversacion.id, 'b_tox', 20, 0, a.id)).total).toBe(0);
  });
});

});
