import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../../prisma/prisma.service';
import { ClientesService } from '../clientes/clientes.service';

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

  async findOne(id: string) {
    const conversacion = await this.prisma.conversacion.findUnique({
      where: { id },
      include: {
        cliente: { select: { id: true, nombre: true, telefono: true, email: true, categoria: true, datosExtra: true } },
        agente: { select: { id: true, nombre: true } },
        mensajes: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!conversacion) {
      throw new NotFoundException(`Conversación ${id} no encontrada`);
    }
    return conversacion;
  }

  async enviarMensaje(conversacionId: string, contenido: string, agenteId: string) {
    const conversacion = await this.findOne(conversacionId);

    const mensaje = await this.prisma.mensaje.create({
      data: { conversacionId, direccion: 'SALIENTE', contenido },
    });

    await this.prisma.conversacion.update({
      where: { id: conversacionId },
      data: { agenteId, updatedAt: new Date() },
    });

    /* Envío real por WhatsApp Cloud API si el token y phone_id están en .env */
    const token = this.config.get<string>('WHATSAPP_TOKEN') || this.config.get<string>('WHATSAPP_ACCESS_TOKEN');
    const phoneId = this.config.get<string>('WHATSAPP_PHONE_ID') || this.config.get<string>('WHATSAPP_PHONE_NUMBER_ID');

    if (token && phoneId) {
      try {
        const destino = conversacion.cliente.telefono.replace(/\+/g, '').trim();
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
        } else {
          const data = await response.json();
          this.logger.log(`Mensaje WhatsApp enviado a +${destino}. Meta ID: ${data.messages?.[0]?.id}`);
        }
      } catch (error) {
        this.logger.error('Excepción al conectar con Meta Graph API', error);
      }
    }

    return { ...mensaje, clienteTelefono: conversacion.cliente.telefono };
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

    const mensaje = await this.prisma.mensaje.create({
      data: {
        conversacionId: conversacion.id,
        direccion: 'ENTRANTE',
        contenido,
        whatsappMsgId,
      },
    });

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

    return mensaje;
  }
}
