import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { ClientesService } from '../clientes/clientes.service';

/**
 * Módulo Conversaciones — RF-09/RF-10.
 * Persiste toda la mensajería vinculada a cliente + agente.
 * El envío real por WhatsApp Cloud API queda pendiente de configurar
 * WHATSAPP_TOKEN/WHATSAPP_PHONE_ID en .env — la persistencia ya es definitiva.
 */
@Injectable()
export class ConversacionesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clientesService: ClientesService,
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

    /* TODO (requiere WHATSAPP_TOKEN): POST a graph.facebook.com/{phone_id}/messages.
       Hasta entonces el mensaje queda persistido y visible en el CRM. */
    const mensaje = await this.prisma.mensaje.create({
      data: { conversacionId, direccion: 'SALIENTE', contenido },
    });

    await this.prisma.conversacion.update({
      where: { id: conversacionId },
      data: { agenteId, updatedAt: new Date() },
    });

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
  async procesarEntrante(telefono: string, contenido: string, whatsappMsgId?: string) {
    if (whatsappMsgId) {
      const yaExiste = await this.prisma.mensaje.findUnique({ where: { whatsappMsgId } });
      if (yaExiste) {
        return yaExiste; // WhatsApp reintenta webhooks: idempotencia por msg id
      }
    }

    let cliente = await this.clientesService.findByTelefono(telefono);
    if (!cliente) {
      cliente = await this.clientesService.create({
        nombre: `WhatsApp ${telefono}`,
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

    await this.prisma.conversacion.update({
      where: { id: conversacion.id },
      data: { updatedAt: new Date() },
    });

    return mensaje;
  }
}
