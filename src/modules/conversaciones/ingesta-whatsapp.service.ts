import { Injectable, Logger } from '@nestjs/common';
import { OrigenLead, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { ClientesService } from '../clientes/clientes.service';
import { AcuseAutomaticoService } from './acuse-automatico.service';
import { ConversacionesGateway } from './conversaciones.gateway';
import { DespachadorSalienteService } from './despachador-saliente.service';
import { MediaEntranteService, MediaEntrante } from './media-entrante.service';

/** Contexto de campaña publicitaria / anuncio de Meta (Click-to-WhatsApp Ads). */
export interface ReferenciaCampana {
  origenTipo?: string;
  anuncioId?: string;
  titular?: string;
  cuerpo?: string;
  origenUrl?: string;
  imagenUrl?: string;
}

/**
 * Extraído de `ConversacionesService` (que llegó a mezclar CRUD, mensajería
 * saliente y esto en una sola clase de 1000+ líneas). Este servicio es SOLO la
 * mitad de entrada: convertir un mensaje entrante de WhatsApp en cliente +
 * conversación + lead + notificación, con la idempotencia y la concurrencia
 * que exige un webhook. La mitad de salida (enviar, marcar leído, plantillas,
 * ticks de entrega) se queda en `ConversacionesService`; la de lectura/CRUD
 * también. Ninguna de las dos llama a `obtenerConversacionPropia` ni a la
 * visibilidad por rol — eso es del lado del agente navegando el inbox, no del
 * webhook.
 *
 * Único llamador: `WhatsappWebhookController`.
 */
@Injectable()
export class IngestaWhatsappService {
  private readonly logger = new Logger(IngestaWhatsappService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clientesService: ClientesService,
    private readonly gateway: ConversacionesGateway,
    private readonly acuse: AcuseAutomaticoService,
    private readonly despachador: DespachadorSalienteService,
    private readonly mediaEntrante: MediaEntranteService,
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
    referral?: ReferenciaCampana,
    /** true = este mensaje entrante es el clic en un botón del acuse fuera de horario (ver `WhatsappWebhookController`). */
    esRespuestaBotonAcuse = false,
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

    /* Contexto de campaña / anuncio de Meta (Click-to-WhatsApp Ads) */
    const esInstagram = Boolean(
      referral?.origenUrl?.toLowerCase().includes('instagram') ||
      referral?.origenTipo?.toLowerCase().includes('instagram'),
    );
    const origenLead: OrigenLead = referral
      ? (esInstagram ? OrigenLead.INSTAGRAM_LEAD_AD : OrigenLead.FACEBOOK_LEAD_AD)
      : OrigenLead.WHATSAPP_DIRECTO;

    if (referral?.titular || referral?.anuncioId || referral?.cuerpo) {
      if (referral.titular) {
        const yaTieneInteres = await this.prisma.interes.findFirst({
          where: { clienteId: cliente.id, descripcion: referral.titular },
          select: { id: true },
        });
        if (!yaTieneInteres) {
          await this.prisma.interes.create({
            data: {
              clienteId: cliente.id,
              descripcion: referral.titular,
              origen: origenLead,
              agenteId: cliente.agenteId,
            },
          });
        }
      }

      const datosActuales = (cliente.datosExtra && typeof cliente.datosExtra === 'object'
        ? cliente.datosExtra
        : {}) as Record<string, unknown>;
      await this.prisma.cliente.update({
        where: { id: cliente.id },
        data: {
          datosExtra: {
            ...datosActuales,
            campanaOrigen: {
              titular: referral.titular ?? null,
              anuncioId: referral.anuncioId ?? null,
              cuerpo: referral.cuerpo ?? null,
              origenUrl: referral.origenUrl ?? null,
              imagenUrl: referral.imagenUrl ?? null,
              fecha: new Date().toISOString(),
            },
          },
        },
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
    if (media && this.mediaEntrante.habilitado) {
      void this.mediaEntrante.traer(mensaje.id, conversacion.id, media);
    }

    /* Auto-crear el Lead de Oportunidades SOLO en el primer contacto: se ata a
       que la conversación se haya creado nueva en ESTA petición. Antes se hacía
       con `lead.findFirst → create` sin escopar, que bajo carrera creaba un lead
       por cada webhook simultáneo (Lead no es único por cliente — un cliente
       puede tener varias oportunidades). Como la creación de la conversación
       está serializada por el índice único, exactamente un webhook ve `esNueva`. */
    /* El lead va en su propio try/catch, y no por desconfiar de la línea de
       arriba: es la misma regla que el webhook aplica a cada elemento de un
       lote. Lo que viene después —la notificación push a la agente y el acuse
       fuera de horario— es lo que hace que alguien atienda a la paciente; el
       lead es contabilidad. Si algún día vuelve a fallar esta escritura, que se
       pierda el registro, no el aviso. */
    if (esNueva) {
      try {
        await this.prisma.lead.create({
          data: {
            clienteId: cliente.id,
            origen: origenLead,
            estado: 'NUEVO',
            /* El id del ANUNCIO va a su columna, que no es única.
               Estuvo yendo a `metaLeadId`, que sí lo es porque guarda el
               `leadgen_id` de Lead Ads —uno por persona— y con él deduplica
               `procesarLeadMeta` los reintentos del webhook. Un anuncio lo
               clican muchas pacientes: la primera creaba su lead y de la
               segunda en adelante el INSERT reventaba con P2002. */
            anuncioId: referral?.anuncioId || null,
            agenteId: cliente.agenteId,
          },
        });
      } catch (error) {
        this.logger.error(
          `No se pudo crear el lead de primer contacto para ${cliente.id} ` +
            `(anuncio ${referral?.anuncioId ?? 'ninguno'})`,
          error,
        );
      }
    }

    /* Refresca el inbox de quien lo tenga abierto y avisa al teléfono de quien
       no. **Es el único sitio del módulo que manda notificación push**: aquí y
       solo aquí ha escrito una paciente. La dueña sale del cliente y no de la
       conversación: si el chat está en el pool, `agenteId` es null y el aviso
       va a todo el equipo. */
    this.gateway.notificarEntrante(conversacion.id, {
      clienteNombre: cliente.nombre,
      texto: contenido,
      agenteId: conversacion.agenteId ?? cliente.agenteId,
    });

    /* Acuse fuera de horario. Sin `await`, como todo lo que habla con Meta: el
       webhook tiene que responder en milisegundos. */
    void this.responderFueraDeHorario(conversacion.id, cliente.telefono);

    /* El clic en un botón del acuse hoy no disparaba nada más: el título
       quedaba en el chat como si el paciente lo hubiera escrito, y ahí se
       cortaba. Esto pide nombre y edad para que quien abra el chat después
       ya sepa con quién habla. */
    if (esRespuestaBotonAcuse) {
      void this.pedirDatosDelPaciente(conversacion.id, cliente.telefono);
    }

    return mensaje;
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
  ): Promise<{ conversacion: { id: string; agenteId: string | null }; esNueva: boolean }> {
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
    /* La decisión —configuración, horario y validación de los botones— vive en
       `AcuseAutomaticoService`, que no toca base ni red y por eso se prueba en
       milisegundos. Aquí solo queda el efecto. */
    const acuse = this.acuse.decidir(this.ahora());
    if (!acuse) return;

    try {
      /* Una sola vez por conversación mientras siga cerrado. Un paciente que
         manda cinco mensajes seguidos no puede recibir cinco acuses idénticos:
         se lee como un sistema roto y molesta a quien ya está esperando. */
      const desde = new Date(this.ahora().getTime() - this.acuse.esperaHoras * 60 * 60 * 1000);
      const yaAvisado = await this.prisma.mensaje.findFirst({
        where: { conversacionId, automatico: true, createdAt: { gte: desde } },
        select: { id: true },
      });
      if (yaAvisado) return;

      const mensaje = await this.guardarMensajeAutomatico(conversacionId, acuse.texto);

      const destino = { mensajeId: mensaje.id, conversacionId, telefono };
      if (acuse.botones) {
        await this.despachador.botones(destino, acuse.texto, acuse.botones);
      } else {
        await this.despachador.texto(destino, acuse.texto);
      }
    } catch (error) {
      /* Nunca puede tumbar la entrada del mensaje del paciente: lo importante
         ya está guardado, el acuse es un extra. */
      this.logger.error('No se pudo enviar el acuse fuera de horario', error);
    }
  }

  /**
   * Tras un clic en los botones del acuse, pide nombre y edad — hasta ahora el
   * clic no disparaba nada más (ver `procesarEntrante`).
   *
   * Una sola vez POR SIEMPRE en la conversación, a diferencia del acuse (que
   * se repite cada `esperaHoras`): una vez que el paciente contestó, no hace
   * falta volver a pedirlo aunque pasen semanas y el chat vuelva a cerrarse
   * fuera de horario. Se identifica por el propio contenido del mensaje —no
   * hace falta una columna nueva para "ya se pidió".
   */
  private async pedirDatosDelPaciente(conversacionId: string, telefono: string): Promise<void> {
    const texto = this.acuse.decidirPedidoDatos();
    if (!texto) return; // apagado mientras no exista AUTORESPUESTA_PEDIDO_DATOS

    try {
      const yaPedido = await this.prisma.mensaje.findFirst({
        where: { conversacionId, automatico: true, contenido: texto },
        select: { id: true },
      });
      if (yaPedido) return;

      const mensaje = await this.guardarMensajeAutomatico(conversacionId, texto);
      await this.despachador.texto({ mensajeId: mensaje.id, conversacionId, telefono }, texto);
    } catch (error) {
      /* Mismo criterio que el acuse: nunca tumba la entrada del mensaje del
         paciente, que ya está guardada. */
      this.logger.error('No se pudo enviar el pedido de nombre y edad tras el clic en el acuse', error);
    }
  }

  /**
   * Guarda un mensaje SALIENTE marcado `automatico: true` y bumpea la
   * conversación — el mismo par de escrituras que necesitan el acuse y el
   * pedido de datos, así que vive en un solo sitio.
   */
  private async guardarMensajeAutomatico(conversacionId: string, contenido: string) {
    const [mensaje] = await this.prisma.$transaction([
      this.prisma.mensaje.create({
        data: {
          conversacionId,
          direccion: 'SALIENTE',
          contenido,
          estadoEnvio: 'ENVIADO',
          /* La marca que impide que esto tape la conversación en el inbox —
             ver el comentario del campo en schema.prisma. */
          automatico: true,
        },
      }),
      this.prisma.conversacion.update({
        where: { id: conversacionId },
        data: { updatedAt: new Date() },
      }),
    ]);

    this.gateway.emitirActividad(conversacionId);
    return mensaje;
  }
}
