import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, TipoMensaje } from '@prisma/client';

import { R2Service } from '../../common/storage/r2.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientesService } from '../clientes/clientes.service';
import { ConversacionesGateway } from './conversaciones.gateway';
import { estaAtendiendo, parsearHorario, ZONA_POR_DEFECTO } from './horario-atencion';

/** Media entrante ya normalizada por el webhook (ver extraerMedia). */
export interface MediaEntrante {
  tipo: TipoMensaje;
  mediaId: string;
  mime: string;
  nombre?: string;
}

/** Mensajes que trae el detalle inicial de una conversación (más recientes primero, luego se reordenan).
 *  Se acota a 50 para máxima velocidad inicial; los anteriores se cargan por cursor al hacer scroll. */
const LIMITE_MENSAJES_DETALLE = 50;

/**
 * Tope de la media entrante que se baja a memoria. WhatsApp acepta documentos
 * de hasta 100 MB, y `arrayBuffer()` los carga enteros: dos o tres a la vez
 * tumban un VPS de 1,7 GB donde además viven otras dos apps. 25 MB cubre de
 * sobra fotos, audios y PDFs de estudios, que es lo que manda un paciente.
 */
const MAX_BYTES_MEDIA = 25 * 1024 * 1024;

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
/** Lo mínimo que el filtro de conversaciones necesita de un agente. */
export interface AgenteResumen {
  id: string;
  nombre: string;
}

/**
 * Visibilidad por rol de una conversación, en UN solo sitio.
 *
 * Un AGENTE ve: las suyas, las de sus clientes, y las que no tiene nadie (pool).
 * De ADMIN para arriba `soloAgenteId` llega `undefined` y se ve todo.
 *
 * Están las dos formas —consulta y chequeo en memoria— juntas a propósito: el
 * listado filtraba también por `cliente.agenteId` pero el detalle solo miraba
 * `conversacion.agenteId`, así que había chats que el agente veía en la lista y
 * daban 404 al abrirlos. Es la misma lección que `alcanceAgente()`: dos copias
 * de la misma regla en sitios distintos terminan divergiendo. Si cambias una,
 * cambias la otra — están pegadas para que se note.
 */
function whereVisibilidad(soloAgenteId?: string): Prisma.ConversacionWhereInput | undefined {
  if (!soloAgenteId) return undefined;
  return {
    OR: [
      { agenteId: soloAgenteId },
      { agenteId: null },
      { cliente: { agenteId: soloAgenteId } },
    ],
  };
}

/**
 * Botones del acuse, leídos de `AUTORESPUESTA_BOTONES` ("Agendar cita|Resultados").
 *
 * Meta acepta **como mucho 3 botones de 20 caracteres**. Si algo no encaja se
 * devuelve `null` y el acuse sale como texto plano: un `interactive` malformado
 * lo rechaza Meta ENTERO, así que el paciente no recibiría nada — peor que no
 * tener botones. Ante la duda, degradar en vez de fallar.
 */
export function leerBotones(texto: string | undefined): string[] | null {
  const botones = (texto ?? '')
    .split('|')
    .map(b => b.trim())
    .filter(Boolean);

  if (botones.length === 0 || botones.length > 3) return null;
  if (botones.some(b => b.length > 20)) return null;
  /* Meta rechaza dos botones con el mismo título. */
  if (new Set(botones).size !== botones.length) return null;

  return botones;
}

/** Contraparte en memoria de `whereVisibilidad`, para las lecturas por ID. */
function puedeVerConversacion(
  conversacion: { agenteId: string | null; cliente?: { agenteId?: string | null } | null },
  soloAgenteId?: string,
): boolean {
  if (!soloAgenteId) return true;
  return (
    conversacion.agenteId === soloAgenteId ||
    conversacion.agenteId === null ||
    conversacion.cliente?.agenteId === soloAgenteId
  );
}

@Injectable()
export class ConversacionesService {
  private readonly logger = new Logger(ConversacionesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clientesService: ClientesService,
    private readonly config: ConfigService,
    private readonly gateway: ConversacionesGateway,
    private readonly r2: R2Service,
  ) {}

  /**
   * El reloj, como método y no como `new Date()` suelto.
   *
   * Es la costura que permite probar "un domingo a las 18:00" sin congelar los
   * temporizadores del proceso: los fake timers de Jest también paran los que
   * Prisma usa por dentro, y la consulta no vuelve nunca. Una función que se
   * puede sustituir sale más barata que pelear con eso, y deja escrito que el
   * tiempo es una ENTRADA de esta lógica, no un detalle ambiental.
   */
  protected ahora(): Date {
    return new Date();
  }

  private agentesCache: { data: AgenteResumen[]; expiresAt: number } | null = null;
  private plantillasCache: { data: PlantillaResumen[]; expiresAt: number } | null = null;

  /** Visibilidad por rol: AGENTE ve sus conversaciones + las sin asignar; ADMIN todo. */
  async findAll(soloAgenteId?: string) {
    const conversaciones = await this.prisma.conversacion.findMany({
      where: whereVisibilidad(soloAgenteId),
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        updatedAt: true,
        cliente: {
          select: {
            id: true,
            nombre: true,
            telefono: true,
            categoria: true,
            agente: { select: { id: true, nombre: true } },
          },
        },
        agente: { select: { id: true, nombre: true } },
        mensajes: {
          /* `automatico` viaja aunque el listado no lo pinte: es lo que permite
             al inbox distinguir "ya le contestó alguien" de "solo salió el
             acuse fuera de horario". Sin él, la pestaña "Sin responder" daría
             por atendido todo lo que llegó un fin de semana. */
          select: {
            id: true,
            contenido: true,
            direccion: true,
            estadoEnvio: true,
            tipo: true,
            automatico: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        _count: {
          select: {
            mensajes: {
              where: { direccion: 'ENTRANTE', leidoEn: null },
            },
          },
        },
      },
      take: 100,
    });

    return conversaciones.map(c => ({
      ...c,
      agente: c.agente ?? c.cliente?.agente ?? null,
      noLeidosCount: c._count.mensajes,
    }));
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
        cliente: {
          select: {
            id: true,
            nombre: true,
            telefono: true,
            email: true,
            categoria: true,
            pac: true,
            fechaNacimiento: true,
            ocupacion: true,
            empresaTrabajo: true,
            ciLugar: true,
            datosExtra: true,
            /* Lo consume `puedeVerConversacion`: sin esto el detalle no puede
               aplicar la misma regla de visibilidad que el listado. */
            agenteId: true,
            agente: { select: { id: true, nombre: true } },
          },
        },
        agente: { select: { id: true, nombre: true } },
        /* Se traen las más recientes primero (para poder acotar con `take`)
           y se reordenan a ascendente en memoria — invertir 300 elementos
           es despreciable frente a traer un historial sin límite. */
        mensajes: { orderBy: { createdAt: 'desc' }, take: LIMITE_MENSAJES_DETALLE },
      },
    });
    if (!conversacion || !puedeVerConversacion(conversacion, soloAgenteId)) {
      throw new NotFoundException(`Conversación ${id} no encontrada`);
    }
    conversacion.mensajes.reverse();

    /* A cada mensaje con archivo se le adjunta una URL firmada fresca (15 min):
       el frontend la usa como `src` de la imagen/audio/enlace. Se firman en
       paralelo; los mensajes de solo texto no pagan nada. */
    const mensajes = await Promise.all(
      conversacion.mensajes.map(async m => ({
        ...m,
        mediaUrl: m.mediaKey ? await this.r2.urlFirmada(m.mediaKey) : null,
      })),
    );
    return {
      ...conversacion,
      agente: conversacion.agente ?? conversacion.cliente?.agente ?? null,
      mensajes,
    };
  }

  /**
   * Paginación por CURSOR para mensajes antiguos (scroll infinito hacia arriba).
   * Filtra mensajes creados estrictamente ANTES del timestamp dado (`antesDe`).
   */
  async obtenerMensajesAnteriores(id: string, antesDe: string, limit = 50, soloAgenteId?: string) {
    await this.obtenerConversacionPropia(id, soloAgenteId);
    const limiteParsed = Math.min(Math.max(Number(limit) || 50, 1), 100);

    const mensajes = await this.prisma.mensaje.findMany({
      where: {
        conversacionId: id,
        createdAt: { lt: new Date(antesDe) },
      },
      orderBy: { createdAt: 'desc' },
      take: limiteParsed,
    });
    mensajes.reverse();

    return Promise.all(
      mensajes.map(async m => ({
        ...m,
        mediaUrl: m.mediaKey ? await this.r2.urlFirmada(m.mediaKey) : null,
      })),
    );
  }

  /** Versión liviana del chequeo de propiedad de `findOne`, sin traer mensajes:
   *  la usan `enviarMensaje`/`asignarAgente`, que solo necesitan confirmar
   *  dueño + el teléfono del cliente, no el historial completo del chat. */
  private async obtenerConversacionPropia(id: string, soloAgenteId?: string) {
    const conversacion = await this.prisma.conversacion.findUnique({
      where: { id },
      select: {
        id: true,
        agenteId: true,
        clienteId: true,
        cliente: { select: { telefono: true, agenteId: true } },
      },
    });
    if (!conversacion || !puedeVerConversacion(conversacion, soloAgenteId)) {
      throw new NotFoundException(`Conversación ${id} no encontrada`);
    }
    return conversacion;
  }

  /**
   * `soloAgenteId` — ver la nota de `findOne`. Si la conversación estaba sin
   * asignar, el envío la asigna al agente que responde primero.
   *
   * "Si estaba sin asignar" es literal: antes el `update` escribía `agenteId`
   * siempre, así que un ADMIN que contestara un chat ajeno se lo quitaba al
   * agente que lo tenía — y con la conversación se movía la atribución. Ahora
   * la condición la evalúa la base (`updateMany` con `agenteId: null` en el
   * where), que además resuelve el empate si dos agentes contestan a la vez el
   * mismo chat del pool: exactamente uno se lo lleva.
   */
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
      /* Solo reclama el chat si está en el pool — ver la nota del método. */
      this.prisma.conversacion.updateMany({
        where: { id: conversacionId, agenteId: null },
        data: { agenteId },
      }),
      this.prisma.conversacion.update({
        where: { id: conversacionId },
        data: { updatedAt: new Date() },
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

  /**
   * Manda el acuse como mensaje interactivo con botones de respuesta rápida.
   *
   * El paciente toca uno y su elección vuelve por el webhook como un mensaje
   * normal: `extraerRespuestaBoton` ya sabe leer `interactive.button_reply.title`
   * —se arregló al tapar el aislamiento del lote— así que no hace falta tocar
   * nada del lado entrante. El valor no es automatizar la gestión, que sigue
   * necesitando una persona: es que el lunes el hilo diga "Agendar una cita" en
   * lugar de "hola".
   *
   * Si Meta rechaza el interactivo se reintenta como texto plano. Un acuse feo
   * es mejor que ninguno.
   */
  private async enviarBotonesPorWhatsApp(
    mensajeId: string,
    conversacionId: string,
    telefono: string,
    texto: string,
    botones: string[],
  ): Promise<void> {
    const token = this.config.get<string>('WHATSAPP_TOKEN') || this.config.get<string>('WHATSAPP_ACCESS_TOKEN');
    const phoneId = this.config.get<string>('WHATSAPP_PHONE_ID') || this.config.get<string>('WHATSAPP_PHONE_NUMBER_ID');
    if (!token || !phoneId) return;

    try {
      const destino = telefono.replace(/\+/g, '').trim();
      const response = await fetch(`https://graph.facebook.com/v25.0/${phoneId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: destino,
          type: 'interactive',
          interactive: {
            type: 'button',
            body: { text: texto },
            action: {
              /* El `id` vuelve en el webhook junto al título; se numera para no
                 depender del texto, que la clínica puede reescribir. */
              buttons: botones.map((titulo, i) => ({
                type: 'reply',
                reply: { id: `acuse_${i + 1}`, title: titulo },
              })),
            },
          },
        }),
      });

      if (!response.ok) {
        this.logger.error(
          `Meta rechazó el acuse con botones (${response.status}): ${await response.text()} — se reintenta como texto`,
        );
        await this.enviarPorWhatsApp(mensajeId, conversacionId, telefono, texto);
        return;
      }

      const data = await response.json();
      const metaMsgId: string | undefined = data.messages?.[0]?.id;
      if (metaMsgId) {
        await this.prisma.mensaje.update({
          where: { id: mensajeId },
          data: { whatsappMsgId: metaMsgId },
        });
      }
      this.gateway.emitirActividad(conversacionId);
    } catch (error) {
      this.logger.error('Excepción enviando el acuse con botones; se reintenta como texto', error);
      await this.enviarPorWhatsApp(mensajeId, conversacionId, telefono, texto);
    }
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

      /* Detectar si el contenido es una URL de imagen o documento PDF */
      const esUrl = contenido.trim().startsWith('http://') || contenido.trim().startsWith('https://');
      const esImagen = esUrl && /\.(png|jpe?g|webp|gif)(\?.*)?$/i.test(contenido.trim());
      const esPdf = esUrl && /\.pdf(\?.*)?$/i.test(contenido.trim());

      let metaPayload: Record<string, unknown>;

      if (esImagen) {
        metaPayload = {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: destino,
          type: 'image',
          image: { link: contenido.trim() },
        };
      } else if (esPdf) {
        metaPayload = {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: destino,
          type: 'document',
          document: { link: contenido.trim(), filename: 'Documento.pdf' },
        };
      } else {
        metaPayload = {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: destino,
          type: 'text',
          text: { body: contenido },
        };
      }

      const response = await fetch(`https://graph.facebook.com/v25.0/${phoneId}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(metaPayload),
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
  async listarPlantillas(forceRefresh = false): Promise<PlantillaResumen[]> {
    const ahora = Date.now();
    if (!forceRefresh && this.plantillasCache && ahora < this.plantillasCache.expiresAt) {
      return this.plantillasCache.data;
    }

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
        return this.plantillasCache?.data ?? [];
      }
      const data = (await response.json()) as { data?: PlantillaMeta[] };
      const resultado = (data.data ?? [])
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

      // Guardar en cache por 10 minutos (600.000 ms)
      this.plantillasCache = { data: resultado, expiresAt: ahora + 600000 };
      return resultado;
    } catch (error) {
      this.logger.error('Excepción al listar plantillas de Meta', error);
      return this.plantillasCache?.data ?? [];
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
      /* Mismo criterio que `enviarMensaje`: reclamar solo si está en el pool. */
      this.prisma.conversacion.updateMany({
        where: { id: conversacionId, agenteId: null },
        data: { agenteId },
      }),
      this.prisma.conversacion.update({
        where: { id: conversacionId },
        data: { updatedAt: new Date() },
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

  /**
   * Marca el último mensaje entrante como leído (tildes azules para el
   * paciente) y, si `typing`, muestra "escribiendo…". Se llama al abrir el
   * chat y mientras el agente redacta — así el paciente ve que lo atienden,
   * como en cualquier CRM de primer nivel. Fire-and-forget: nunca demora la UI.
   */
  async marcarLeido(conversacionId: string, soloAgenteId?: string, typing = false): Promise<{ ok: boolean }> {
    const conv = await this.prisma.conversacion.findUnique({
      where: { id: conversacionId },
      select: { id: true, agenteId: true, cliente: { select: { agenteId: true } } },
    });
    if (!conv || !puedeVerConversacion(conv, soloAgenteId)) {
      return { ok: false };
    }

    /* Marca todos los mensajes entrantes sin leer como leídos en la BD */
    await this.prisma.mensaje.updateMany({
      where: { conversacionId, direccion: 'ENTRANTE', leidoEn: null },
      data: { leidoEn: new Date() },
    });

    /* Solo los mensajes entrantes tienen whatsappMsgId para referenciar */
    const ultimoEntrante = await this.prisma.mensaje.findFirst({
      where: { conversacionId, direccion: 'ENTRANTE', whatsappMsgId: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { whatsappMsgId: true },
    });
    if (ultimoEntrante?.whatsappMsgId) {
      void this.enviarEstadoLectura(ultimoEntrante.whatsappMsgId, typing);
    }
    return { ok: true };
  }

  /** Ver `marcarLeido`: se dispara sin await a propósito. */
  private async enviarEstadoLectura(whatsappMsgId: string, typing: boolean): Promise<void> {
    const token = this.config.get<string>('WHATSAPP_TOKEN') || this.config.get<string>('WHATSAPP_ACCESS_TOKEN');
    const phoneId = this.config.get<string>('WHATSAPP_PHONE_ID') || this.config.get<string>('WHATSAPP_PHONE_NUMBER_ID');
    if (!token || !phoneId) {
      return;
    }
    try {
      const response = await fetch(`https://graph.facebook.com/v25.0/${phoneId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: whatsappMsgId,
          ...(typing ? { typing_indicator: { type: 'text' } } : {}),
        }),
      });
      if (!response.ok) {
        this.logger.warn(`No se pudo marcar leído (${response.status}): ${await response.text()}`);
      }
    } catch (error) {
      this.logger.error('Excepción al marcar leído en Meta Graph API', error);
    }
  }

  /**
   * Asignar/reasignar un agente a una conversación (solo ADMIN).
   *
   * Reasignar un chat arrastra al cliente y a sus leads — si no, el inbox diría
   * una cosa y Oportunidades otra. Pero esas dos tablas son de otros dominios:
   * antes se escribían aquí con `prisma.cliente.update` y `prisma.lead.updateMany`,
   * saltándose la regla de oro nº1 y, de paso, la auditoría. `ClientesService.update()`
   * ya hacía exactamente esta cascada (cliente + leads + conversaciones) y además
   * registra en `AuditLog`, así que la reasignación es suya y aquí solo se pide.
   */
  async asignarAgente(conversacionId: string, agenteId: string | null, usuarioId?: string) {
    const conversacion = await this.prisma.conversacion.findUnique({
      where: { id: conversacionId },
      select: { id: true, clienteId: true },
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

    await this.clientesService.update(conversacion.clienteId, { agenteId }, usuarioId);

    /* Se relee para devolver la misma forma de antes: el update vive en Clientes
       y devuelve un cliente, no la conversación que espera el inbox. */
    const actualizada = await this.prisma.conversacion.findUniqueOrThrow({
      where: { id: conversacionId },
      include: {
        cliente: {
          select: {
            id: true,
            nombre: true,
            telefono: true,
            categoria: true,
            agente: { select: { id: true, nombre: true } },
          },
        },
        agente: { select: { id: true, nombre: true } },
      },
    });

    return {
      ...actualizada,
      agente: actualizada.agente ?? actualizada.cliente?.agente ?? null,
    };
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
    media?: MediaEntrante,
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
          /* Para media: se guarda el tipo/mime/nombre ya; `mediaKey` queda null
             hasta que la descarga+subida a R2 termine en segundo plano. */
          tipo: media?.tipo ?? 'TEXTO',
          mediaMime: media?.mime ?? null,
          mediaNombre: media?.nombre ?? null,
        },
      }),
      this.prisma.conversacion.update({
        where: { id: conversacion.id },
        data: { updatedAt: new Date() },
      }),
    ]);

    /* La media se descarga de Meta y se sube a R2 SIN await: el webhook debe
       responder 200 rápido (si tarda, Meta reintenta y termina desactivando la
       suscripción). Al terminar, se actualiza mediaKey y se avisa por WebSocket
       para que el chat muestre la foto sin recargar. */
    if (media && this.r2.habilitado) {
      void this.descargarYSubirMedia(mensaje.id, conversacion.id, media);
    }

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
          agenteId: cliente.agenteId,
        },
      });
    }

    /* Empuja el refresco a los agentes conectados — así el mensaje aparece
       en segundos en vez de esperar el próximo poll. */
    this.gateway.emitirActividad(conversacion.id);

    /* Acuse fuera de horario. Sin `await`, como todo lo que habla con Meta: el
       webhook tiene que responder en milisegundos. */
    void this.responderFueraDeHorario(conversacion.id, cliente.telefono);

    return mensaje;
  }

  /**
   * Contesta al paciente que escribe cuando no hay nadie atendiendo.
   *
   * Cabe en la ventana de 24h que abre su propio mensaje, así que va como texto
   * libre: no necesita plantilla aprobada y desde julio de 2025 no cuesta nada.
   *
   * **Apagado mientras no exista `AUTORESPUESTA_TEXTO`.** El mensaje lo escribe
   * la clínica —incluye su teléfono de urgencias— y no hay texto por defecto a
   * propósito: un acuse inventado que mande a un paciente con una urgencia a un
   * número equivocado es peor que no contestar.
   */
  private async responderFueraDeHorario(conversacionId: string, telefono: string): Promise<void> {
    const texto = this.config.get<string>('AUTORESPUESTA_TEXTO')?.trim();
    if (!texto) return;

    const horario = parsearHorario(
      this.config.get<string>('AUTORESPUESTA_HORARIO'),
      this.config.get<string>('AUTORESPUESTA_ZONA') || ZONA_POR_DEFECTO,
    );
    /* Horario ausente o mal escrito: no se contesta. Callar es reversible;
       decirle "estamos cerrados" a quien escribe un martes a las diez, no. */
    if (!horario || estaAtendiendo(this.ahora(), horario)) return;

    try {
      /* Una sola vez por conversación mientras siga cerrado. Un paciente que
         manda cinco mensajes seguidos no puede recibir cinco acuses idénticos:
         se lee como un sistema roto y molesta a quien ya está esperando. */
      const horas = Number(this.config.get<string>('AUTORESPUESTA_ESPERA_HORAS')) || 12;
      const desde = new Date(this.ahora().getTime() - horas * 60 * 60 * 1000);
      const yaAvisado = await this.prisma.mensaje.findFirst({
        where: { conversacionId, automatico: true, createdAt: { gte: desde } },
        select: { id: true },
      });
      if (yaAvisado) return;

      const [mensaje] = await this.prisma.$transaction([
        this.prisma.mensaje.create({
          data: {
            conversacionId,
            direccion: 'SALIENTE',
            contenido: texto,
            estadoEnvio: 'ENVIADO',
            /* La marca que impide que el acuse tape la conversación en el
               inbox — ver el comentario del campo en schema.prisma. */
            automatico: true,
          },
        }),
        this.prisma.conversacion.update({
          where: { id: conversacionId },
          data: { updatedAt: new Date() },
        }),
      ]);

      this.gateway.emitirActividad(conversacionId);

      /* Con botones si están configurados; si no, texto plano. La respuesta del
         paciente vuelve por el webhook como un mensaje normal con el título del
         botón, así que el lunes el agente ve "Agendar una cita" en el hilo en
         vez de un "hola" sin contexto. */
      const botones = leerBotones(this.config.get<string>('AUTORESPUESTA_BOTONES'));
      if (botones) {
        await this.enviarBotonesPorWhatsApp(mensaje.id, conversacionId, telefono, texto, botones);
      } else {
        await this.enviarPorWhatsApp(mensaje.id, conversacionId, telefono, texto);
      }
    } catch (error) {
      /* Nunca puede tumbar la entrada del mensaje del paciente: lo importante
         ya está guardado, el acuse es un extra. */
      this.logger.error('No se pudo enviar el acuse fuera de horario', error);
    }
  }

  /**
   * Descarga la media de Meta y la sube a R2 (fire-and-forget, ver
   * `procesarEntrante`). Flujo: media_id → URL temporal de Meta → bytes →
   * PUT en R2 con clave `wa/<conversacionId>/<mensajeId>`. Al terminar,
   * guarda `mediaKey` y avisa por WebSocket para que la foto aparezca sola.
   */
  private async descargarYSubirMedia(
    mensajeId: string,
    conversacionId: string,
    media: MediaEntrante,
  ): Promise<void> {
    const token = this.config.get<string>('WHATSAPP_TOKEN') || this.config.get<string>('WHATSAPP_ACCESS_TOKEN');
    if (!token) return;

    try {
      /* 1) media_id → URL temporal (válida 5 min). */
      const metaResp = await fetch(`https://graph.facebook.com/v25.0/${media.mediaId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!metaResp.ok) {
        this.logger.error(`No se pudo obtener URL de media ${media.mediaId} (${metaResp.status})`);
        return;
      }
      const { url } = (await metaResp.json()) as { url?: string };
      if (!url) return;

      /* 2) Descargar los bytes (requiere el token también en el CDN de Meta). */
      const archivo = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!archivo.ok) {
        this.logger.error(`No se pudo descargar media ${media.mediaId} (${archivo.status})`);
        return;
      }

      /* El corte real lo hace `content-length`, que Meta siempre manda: descarta
         antes de reservar un solo byte. La comprobación de después es la red de
         seguridad por si algún día llega sin cabecera — ahí ya se pagó la
         memoria, pero al menos no se sube a R2 ni se guarda. */
      const declarado = Number(archivo.headers.get('content-length'));
      if (Number.isFinite(declarado) && declarado > MAX_BYTES_MEDIA) {
        this.logger.warn(
          `Media ${media.mediaId} descartada: ${Math.round(declarado / 1024 / 1024)} MB supera el tope de ${MAX_BYTES_MEDIA / 1024 / 1024} MB`,
        );
        return;
      }

      const bytes = await archivo.arrayBuffer();
      if (bytes.byteLength > MAX_BYTES_MEDIA) {
        this.logger.warn(
          `Media ${media.mediaId} descartada tras descargar: ${Math.round(bytes.byteLength / 1024 / 1024)} MB supera el tope`,
        );
        return;
      }

      /* 3) Subir a R2 y registrar la clave en el mensaje. */
      const key = `wa/${conversacionId}/${mensajeId}`;
      await this.r2.subir(key, bytes, media.mime);
      await this.prisma.mensaje.update({ where: { id: mensajeId }, data: { mediaKey: key } });

      this.gateway.emitirActividad(conversacionId);
    } catch (error) {
      this.logger.error(`Excepción bajando/subiendo media ${media.mediaId}`, error);
    }
  }
}
