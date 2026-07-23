import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { ClientesService } from '../clientes/clientes.service';
import { ConversacionesGateway } from './conversaciones.gateway';

/** Mensajes que trae el detalle de una conversación (más recientes primero, luego se reordenan).
 *  Sin tope, un chat de años de antigüedad haría cada vez más lento cada poll/reload. */
const LIMITE_MENSAJES_DETALLE = 300;

/** Forma cruda de una plantilla en la respuesta de Meta (solo lo que usamos). */
interface PlantillaMeta {
  name: string;
  status: string;
  category: string;
  language: string;
  components?: Array<{ type: string; text?: string }>;
}

/** Plantilla aprobada, simplificada para el selector del inbox. */
export interface PlantillaResumen {
  nombre: string;
  idioma: string;
  categoria: string;
  cuerpo: string;
  variables: number;
}

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

  private agentesCache: { data: any[]; expiresAt: number } | null = null;

  /** Visibilidad por rol: AGENTE ve sus conversaciones + las sin asignar; ADMIN todo. */
  async findAll(soloAgenteId?: string) {
    return this.prisma.conversacion.findMany({
      where: soloAgenteId ? { OR: [{ agenteId: soloAgenteId }, { agenteId: null }] } : undefined,
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        updatedAt: true,
        cliente: { select: { id: true, nombre: true, telefono: true, categoria: true } },
        agente: { select: { id: true, nombre: true } },
        mensajes: {
          select: { id: true, contenido: true, direccion: true, estadoEnvio: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        _count: { select: { mensajes: true } },
      },
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

  /**
   * Lista las plantillas APROBADAS de la WABA — para el selector del inbox.
   * Solo las aprobadas se pueden enviar (Meta rechaza el resto). Se piden los
   * campos mínimos que la UI necesita para previsualizar y contar variables.
   */
  async listarPlantillas(): Promise<PlantillaResumen[]> {
    const token = this.config.get<string>('WHATSAPP_TOKEN') || this.config.get<string>('WHATSAPP_ACCESS_TOKEN');
    const wabaId = this.config.get<string>('WHATSAPP_WABA_ID');
    if (!token || !wabaId) {
      this.logger.warn('WHATSAPP_WABA_ID o token no configurados; no se pueden listar plantillas');
      return [];
    }

    try {
      const url = `https://graph.facebook.com/v25.0/${wabaId}/message_templates?fields=name,status,category,language,components&limit=100`;
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) {
        this.logger.error(`Error listando plantillas (${response.status}): ${await response.text()}`);
        return [];
      }
      const data = (await response.json()) as { data?: PlantillaMeta[] };
      return (data.data ?? [])
        .filter(p => p.status === 'APPROVED')
        .map(p => {
          const body = p.components?.find(c => c.type === 'BODY')?.text ?? '';
          return {
            nombre: p.name,
            idioma: p.language,
            categoria: p.category,
            cuerpo: body,
            /* Nº de variables del cuerpo: cuenta los {{...}} distintos para que
               la UI sepa cuántos campos pedir antes de enviar. */
            variables: [...new Set(body.match(/\{\{[^}]+\}\}/g) ?? [])].length,
          };
        });
    } catch (error) {
      this.logger.error('Excepción al listar plantillas de Meta', error);
      return [];
    }
  }

  /**
   * Envía una plantilla aprobada a un paciente — único modo permitido fuera de
   * la ventana de 24h. Mismo patrón que `enviarMensaje`: persiste, avisa por
   * WebSocket, y dispara la llamada a Meta SIN await (el agente no espera el
   * round-trip). `contenido` es el texto ya renderizado que se guarda.
   */
  async enviarPlantilla(
    conversacionId: string,
    dto: { plantilla: string; idioma: string; parametros?: string[]; contenido: string },
    agenteId: string,
    soloAgenteId?: string,
  ) {
    const conversacion = await this.obtenerConversacionPropia(conversacionId, soloAgenteId);

    const [mensaje] = await this.prisma.$transaction([
      this.prisma.mensaje.create({
        data: { conversacionId, direccion: 'SALIENTE', contenido: dto.contenido, estadoEnvio: 'ENVIADO' },
      }),
      this.prisma.conversacion.update({
        where: { id: conversacionId },
        data: { agenteId, updatedAt: new Date() },
      }),
    ]);

    this.gateway.emitirActividad(conversacionId);

    void this.enviarPlantillaPorWhatsApp(
      mensaje.id,
      conversacionId,
      conversacion.cliente.telefono,
      dto,
    );

    return { ...mensaje, clienteTelefono: conversacion.cliente.telefono };
  }

  /** Ver `enviarPlantilla`: se dispara sin await a propósito. */
  private async enviarPlantillaPorWhatsApp(
    mensajeId: string,
    conversacionId: string,
    telefono: string,
    dto: { plantilla: string; idioma: string; parametros?: string[] },
  ): Promise<void> {
    const token = this.config.get<string>('WHATSAPP_TOKEN') || this.config.get<string>('WHATSAPP_ACCESS_TOKEN');
    const phoneId = this.config.get<string>('WHATSAPP_PHONE_ID') || this.config.get<string>('WHATSAPP_PHONE_NUMBER_ID');
    if (!token || !phoneId) {
      return;
    }

    /* El cuerpo solo se incluye si la plantilla tiene variables; una plantilla
       sin variables con un `components` vacío es rechazada por Meta. */
    const componentes =
      dto.parametros && dto.parametros.length > 0
        ? [{ type: 'body', parameters: dto.parametros.map(text => ({ type: 'text', text })) }]
        : undefined;

    try {
      const destino = telefono.replace(/\+/g, '').trim();
      const response = await fetch(`https://graph.facebook.com/v25.0/${phoneId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: destino,
          type: 'template',
          template: {
            name: dto.plantilla,
            language: { code: dto.idioma },
            ...(componentes ? { components: componentes } : {}),
          },
        }),
      });

      if (!response.ok) {
        this.logger.error(`Error enviando plantilla a Meta (${response.status}): ${await response.text()}`);
        await this.prisma.mensaje.update({ where: { id: mensajeId }, data: { estadoEnvio: 'FALLIDO' } });
      } else {
        const data = await response.json();
        const metaMsgId: string | undefined = data.messages?.[0]?.id;
        this.logger.log(`Plantilla "${dto.plantilla}" enviada a +${destino}. Meta ID: ${metaMsgId}`);
        if (metaMsgId) {
          await this.prisma.mensaje.update({ where: { id: mensajeId }, data: { whatsappMsgId: metaMsgId } });
        }
      }
    } catch (error) {
      this.logger.error('Excepción al enviar plantilla por Meta Graph API', error);
      await this.prisma.mensaje.update({ where: { id: mensajeId }, data: { estadoEnvio: 'FALLIDO' } });
    }

    this.gateway.emitirActividad(conversacionId);
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

  /**
   * Get-or-create de la conversación de un cliente, a prueba de concurrencia.
   * Un inbox de WhatsApp tiene UN hilo por contacto (`Conversacion.clienteId`
   * es único). Mismo patrón que el cliente: intentar crear y, si el único
   * rebota (P2002) porque otro webhook simultáneo la creó primero, releer.
   *
   * Devuelve `esNueva` para que el llamador sepa si ESTA petición fue la que
   * la creó — bajo carrera, exactamente una lo será (el único lo garantiza).
   * Se usa para disparar el auto-alta del Lead una sola vez (ver
   * `procesarEntrante`), que si no tendría su propia race (Lead no es único
   * por cliente porque un cliente puede tener varias oportunidades).
   */
  private async obtenerOCrearConversacion(
    clienteId: string,
  ): Promise<{ conversacion: { id: string }; esNueva: boolean }> {
    const existente = await this.prisma.conversacion.findUnique({ where: { clienteId } });
    if (existente) {
      return { conversacion: existente, esNueva: false };
    }
    try {
      const creada = await this.prisma.conversacion.create({ data: { clienteId } });
      return { conversacion: creada, esNueva: true };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const yaCreada = await this.prisma.conversacion.findUnique({ where: { clienteId } });
        if (yaCreada) {
          return { conversacion: yaCreada, esNueva: false };
        }
      }
      throw error;
    }
  }

  /** Lista de agentes activos — para el dropdown de asignación del admin (cacheada 30s). */
  async findAgentes() {
    const ahora = Date.now();
    if (this.agentesCache && this.agentesCache.expiresAt > ahora) {
      return this.agentesCache.data;
    }
    const agentes = await this.prisma.usuario.findMany({
      where: { activo: true },
      select: { id: true, nombre: true, rol: true },
      orderBy: { nombre: 'asc' },
    });
    this.agentesCache = { data: agentes, expiresAt: ahora + 30000 };
    return agentes;
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

    /* Get-or-create atómico: dos webhooks simultáneos de un número nuevo no
       deben pelearse por el índice único de telefono (antes: 500 + reintento
       de Meta). Ver ClientesService.obtenerOCrearPorTelefono. */
    const cliente = await this.clientesService.obtenerOCrearPorTelefono(
      nombrePerfil || `WhatsApp ${telefono}`,
      telefono,
    );

    const { conversacion, esNueva } = await this.obtenerOCrearConversacion(cliente.id);

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

    /* Auto-crear el Lead de Oportunidades SOLO en el primer contacto: se ata a
       que la conversación se haya creado nueva en ESTA petición. Antes se hacía
       con `lead.findFirst → create` sin escopar, que bajo carrera creaba un lead
       por cada webhook simultáneo (Lead no es único por cliente — un cliente
       puede tener varias oportunidades). Como la creación de la conversación
       está serializada por el índice único, exactamente un webhook ve `esNueva`. */
    if (esNueva) {
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
