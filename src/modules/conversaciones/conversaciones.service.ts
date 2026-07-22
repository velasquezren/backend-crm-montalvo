import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../../prisma/prisma.service';
import { ClientesService } from '../clientes/clientes.service';
import { ConversacionesGateway } from './conversaciones.gateway';

/** Mensajes que trae el detalle de una conversación (más recientes primero, luego se reordenan).
 *  Sin tope, un chat de años de antigüedad haría cada vez más lento cada poll/reload. */
const LIMITE_MENSAJES_DETALLE = 300;

/**
 * Módulo Conversaciones — RF-09/RF-10.
 * Persiste toda la mensajería vinculada a cliente + agente.
 * Si WHATSAPP_TOKEN y WHATSAPP_PHONE_ID están en .env, envía los mensajes por Meta Cloud API.
 */
@Injectable()
export class ConversacionesService {
  private readonly logger = new Logger(ConversacionesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clientesService: ClientesService,
    private readonly config: ConfigService,
    private readonly gateway: ConversacionesGateway,
  ) {}

  /** Visibilidad por rol: AGENTE ve sus conversaciones + las sin asignar; ADMIN todo. */
  async findAll(soloAgenteId?: string) {
    return this.prisma.conversacion.findMany({
      where: soloAgenteId ? { OR: [{ agenteId: soloAgenteId }, { agenteId: null }] } : undefined,
      orderBy: { updatedAt: 'desc' },
      include: {
        cliente: { select: { id: true, nombre: true, telefono: true, categoria: true } },
        agente: { select: { id: true, nombre: true } },
        mensajes: { orderBy: { createdAt: 'desc' }, take: 1 },
        _count: { select: { mensajes: true } },
      },
      /* El inbox no se pagina a propósito: la UI filtra por pestañas
         (Todas / Sin asignar / Mis chats) sobre el conjunto cargado, igual
         que WhatsApp Web. Se acota a las 100 conversaciones más recientes;
         las antiguas se alcanzan por el buscador de clientes. */
      take: 100,
    });
  }

  /**
   * @param soloAgenteId Si viene (usuario AGENTE, no ADMIN), solo puede ver
   *   conversaciones propias o sin asignar. Sin esto, cualquier agente podía
   *   leer o responder la conversación de OTRO agente por ID, sin importar
   *   quién la tenía asignada. 404 en vez de 403 para no confirmar existencia.
   */
  async findOne(id: string, soloAgenteId?: string) {
    const conversacion = await this.prisma.conversacion.findUnique({
      where: { id },
      include: {
        cliente: { select: { id: true, nombre: true, telefono: true, email: true, categoria: true, datosExtra: true } },
        agente: { select: { id: true, nombre: true } },
        /* Se traen las más recientes primero (para poder acotar con `take`)
           y se reordenan a ascendente en memoria — invertir 300 elementos
           es despreciable frente a traer un historial sin límite. */
        mensajes: { orderBy: { createdAt: 'desc' }, take: LIMITE_MENSAJES_DETALLE },
      },
    });
    if (
      !conversacion ||
      (soloAgenteId && conversacion.agenteId && conversacion.agenteId !== soloAgenteId)
    ) {
      throw new NotFoundException(`Conversación ${id} no encontrada`);
    }
    conversacion.mensajes.reverse();
    return conversacion;
  }

  /** Versión liviana del chequeo de propiedad de `findOne`, sin traer mensajes:
   *  la usan `enviarMensaje`/`asignarAgente`, que solo necesitan confirmar
   *  dueño + el teléfono del cliente, no el historial completo del chat. */
  private async obtenerConversacionPropia(id: string, soloAgenteId?: string) {
    const conversacion = await this.prisma.conversacion.findUnique({
      where: { id },
      select: { id: true, agenteId: true, cliente: { select: { telefono: true } } },
    });
    if (
      !conversacion ||
      (soloAgenteId && conversacion.agenteId && conversacion.agenteId !== soloAgenteId)
    ) {
      throw new NotFoundException(`Conversación ${id} no encontrada`);
    }
    return conversacion;
  }

  /** `soloAgenteId` — ver la nota de `findOne`. Si la conversación estaba sin
   *  asignar, el envío la asigna automáticamente al agente que responde
   *  primero (comportamiento ya existente, ahora también protegido). */
  async enviarMensaje(
    conversacionId: string,
    contenido: string,
    agenteId: string,
    soloAgenteId?: string,
  ) {
    const conversacion = await this.obtenerConversacionPropia(conversacionId, soloAgenteId);

    /* Un solo round-trip a la base para ambos writes, y atómico: si el update
       de la conversación falla, no queda un mensaje huérfano sin reflejarse
       en updatedAt/agenteId. `estadoEnvio: ENVIADO` es optimista (el tick
       sencillo aparece antes de saber si Meta lo aceptó), igual que hace
       WhatsApp/Messenger — se corrige a FALLIDO si el envío real rebota. */
    const [mensaje] = await this.prisma.$transaction([
      this.prisma.mensaje.create({
        data: { conversacionId, direccion: 'SALIENTE', contenido, estadoEnvio: 'ENVIADO' },
      }),
      this.prisma.conversacion.update({
        where: { id: conversacionId },
        data: { agenteId, updatedAt: new Date() },
      }),
    ]);

    /* Empuja el refresco a los demás clientes conectados (ver ConversacionesGateway). */
    this.gateway.emitirActividad(conversacionId);

    /* Envío real por WhatsApp Cloud API — deliberadamente SIN await: el
       agente no debe esperar el round-trip a Meta (300-900ms típico, a veces
       más) para ver su mensaje como enviado. El resultado (Meta ID o FALLIDO)
       se corrige en segundo plano y empuja un segundo aviso por WebSocket
       para actualizar el tick sin que el agente tenga que refrescar. */
    void this.enviarPorWhatsApp(mensaje.id, conversacionId, conversacion.cliente.telefono, contenido);

    return { ...mensaje, clienteTelefono: conversacion.cliente.telefono };
  }

  /** Ver comentario en `enviarMensaje`: se dispara sin await a propósito. */
  private async enviarPorWhatsApp(
    mensajeId: string,
    conversacionId: string,
    telefono: string,
    contenido: string,
  ): Promise<void> {
    const token = this.config.get<string>('WHATSAPP_TOKEN') || this.config.get<string>('WHATSAPP_ACCESS_TOKEN');
    const phoneId = this.config.get<string>('WHATSAPP_PHONE_ID') || this.config.get<string>('WHATSAPP_PHONE_NUMBER_ID');
    if (!token || !phoneId) {
      return; // sin credenciales configuradas: el mensaje queda ENVIADO (solo local), comportamiento previo intacto
    }

    try {
      const destino = telefono.replace(/\+/g, '').trim();
      const response = await fetch(`https://graph.facebook.com/v25.0/${phoneId}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: destino,
          type: 'text',
          text: { body: contenido },
        }),
      });

      if (!response.ok) {
        const errBody = await response.text();
        this.logger.error(`Error enviando WhatsApp a Meta (${response.status}): ${errBody}`);
        await this.prisma.mensaje.update({
          where: { id: mensajeId },
          data: { estadoEnvio: 'FALLIDO' },
        });
      } else {
        const data = await response.json();
        const metaMsgId: string | undefined = data.messages?.[0]?.id;
        this.logger.log(`Mensaje WhatsApp enviado a +${destino}. Meta ID: ${metaMsgId}`);
        /* Guarda el id que asignó Meta — así el webhook de `statuses`
           (entregado/leído) puede correlacionar de vuelta con este mensaje. */
        if (metaMsgId) {
          await this.prisma.mensaje.update({
            where: { id: mensajeId },
            data: { whatsappMsgId: metaMsgId },
          });
        }
      }
    } catch (error) {
      this.logger.error('Excepción al conectar con Meta Graph API', error);
      await this.prisma.mensaje.update({
        where: { id: mensajeId },
        data: { estadoEnvio: 'FALLIDO' },
      });
    }

    /* Avisa de nuevo: el primer aviso (arriba en enviarMensaje) ya hizo que el
       agente viera la burbuja; este es para que el tick se actualice sin
       esperar un reload manual. */
    this.gateway.emitirActividad(conversacionId);
  }

  /**
   * Confirmaciones de entrega/lectura del webhook de WhatsApp (`statuses`).
   * Se correlaciona por `whatsappMsgId` — el id que Meta devolvió al enviar.
   * Un mensaje puede recibir varios statuses de mejor a peor (sent → delivered
   * → read); si llegan fuera de orden, nunca se retrocede LEIDO → ENTREGADO.
   */
  async procesarEstadoMensaje(whatsappMsgId: string, status: string): Promise<void> {
    const mensaje = await this.prisma.mensaje.findUnique({ where: { whatsappMsgId } });
    if (!mensaje) {
      return; // status de un mensaje que no reconocemos (o llegó antes que el propio envío se guardara)
    }

    const ahora = new Date();
    if (status === 'read' && mensaje.estadoEnvio !== 'LEIDO') {
      await this.prisma.mensaje.update({
        where: { id: mensaje.id },
        data: { estadoEnvio: 'LEIDO', leidoEn: mensaje.leidoEn ?? ahora, entregadoEn: mensaje.entregadoEn ?? ahora },
      });
    } else if (status === 'delivered' && mensaje.estadoEnvio !== 'LEIDO' && mensaje.estadoEnvio !== 'ENTREGADO') {
      await this.prisma.mensaje.update({
        where: { id: mensaje.id },
        data: { estadoEnvio: 'ENTREGADO', entregadoEn: ahora },
      });
    } else if (status === 'failed') {
      await this.prisma.mensaje.update({
        where: { id: mensaje.id },
        data: { estadoEnvio: 'FALLIDO' },
      });
    } else {
      return; // 'sent' o repetido: nada nuevo que reflejar
    }

    this.gateway.emitirActividad(mensaje.conversacionId);
  }

  /** Asignar/reasignar un agente a una conversación (solo ADMIN). */
  async asignarAgente(conversacionId: string, agenteId: string | null) {
    const conversacion = await this.prisma.conversacion.findUnique({
      where: { id: conversacionId },
    });
    if (!conversacion) {
      throw new NotFoundException(`Conversación ${conversacionId} no encontrada`);
    }

    if (agenteId) {
      const agente = await this.prisma.usuario.findUnique({ where: { id: agenteId } });
      if (!agente || !agente.activo) {
        throw new NotFoundException(`Agente ${agenteId} no encontrado o inactivo`);
      }
    }

    return this.prisma.conversacion.update({
      where: { id: conversacionId },
      data: { agenteId },
      include: {
        cliente: { select: { id: true, nombre: true, telefono: true, categoria: true } },
        agente: { select: { id: true, nombre: true } },
      },
    });
  }

  /** Lista de agentes activos — para el dropdown de asignación del admin. */
  async findAgentes() {
    return this.prisma.usuario.findMany({
      where: { activo: true },
      select: { id: true, nombre: true, rol: true },
      orderBy: { nombre: 'asc' },
    });
  }

  /**
   * Entrada de mensajes del webhook de WhatsApp (RF-09).
   * Crea cliente y conversación si no existen — RF: registro automático
   * de cliente ante mensaje sin antecedentes.
   */
  /**
   * @param nombrePerfil Nombre del perfil de WhatsApp, si Meta lo envía.
   *   Evita dar de alta al cliente como "WhatsApp +591…" cuando escribe por
   *   primera vez; si no viene, se usa el marcador con el teléfono.
   */
  async procesarEntrante(
    telefono: string,
    contenido: string,
    whatsappMsgId?: string,
    nombrePerfil?: string,
  ) {
    if (whatsappMsgId) {
      const yaExiste = await this.prisma.mensaje.findUnique({ where: { whatsappMsgId } });
      if (yaExiste) {
        return yaExiste; // WhatsApp reintenta webhooks: idempotencia por msg id
      }
    }

    let cliente = await this.clientesService.findByTelefono(telefono);
    if (!cliente) {
      cliente = await this.clientesService.create({
        nombre: nombrePerfil || `WhatsApp ${telefono}`,
        telefono,
      });
    }

    let conversacion = await this.prisma.conversacion.findFirst({
      where: { clienteId: cliente.id },
      orderBy: { updatedAt: 'desc' },
    });
    if (!conversacion) {
      conversacion = await this.prisma.conversacion.create({
        data: { clienteId: cliente.id },
      });
    }

    /* `conversacion.update` bumpea `updatedAt` — sin esto un mensaje entrante
       no subía el chat al tope del inbox (ordenado por updatedAt desc), y el
       agente podía no notar que había algo nuevo hasta revisar chat por chat. */
    const [mensaje] = await this.prisma.$transaction([
      this.prisma.mensaje.create({
        data: {
          conversacionId: conversacion.id,
          direccion: 'ENTRANTE',
          contenido,
          whatsappMsgId,
        },
      }),
      this.prisma.conversacion.update({
        where: { id: conversacion.id },
        data: { updatedAt: new Date() },
      }),
    ]);

    /* Auto-crear Lead en la tabla de Oportunidades (Leads & Prospectos) si no existe */
    const leadExiste = await this.prisma.lead.findFirst({
      where: { clienteId: cliente.id },
    });
    if (!leadExiste) {
      await this.prisma.lead.create({
        data: {
          clienteId: cliente.id,
          origen: 'WHATSAPP_DIRECTO',
          estado: 'NUEVO',
        },
      });
    }

    /* Empuja el refresco a los agentes conectados — así el mensaje aparece
       en segundos en vez de esperar el próximo poll. */
    this.gateway.emitirActividad(conversacion.id);

    return mensaje;
  }
}
