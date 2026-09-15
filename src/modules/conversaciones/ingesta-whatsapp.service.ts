import { LINEA_COMERCIAL_INICIAL } from './acceso-conversacion';
import { Injectable, Logger } from '@nestjs/common';
import { Mensaje, OrigenLead, Prisma } from '../../prisma/prisma-client';

import { enSegundoPlano } from '../../common/fiabilidad/en-segundo-plano';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientesService, nombreProvisional } from '../clientes/clientes.service';
import { PrimerContactoService } from '../leads/primer-contacto.service';
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
  /** Imagen del anuncio, o la miniatura si era un anuncio de video. */
  imagenUrl?: string;
  /** `image` | `video`. */
  mediaTipo?: string;
  videoUrl?: string;
  /** Saludo que el anuncio dejó escrito en el chat de la paciente. */
  saludo?: string;
  /** `ctwa_clid` — lo pide la Conversions API para atribuir una venta a su campaña. */
  clickId?: string;
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
    private readonly primerContacto: PrimerContactoService,
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
    lineaId = LINEA_COMERCIAL_INICIAL,
  ) {
    const linea = await this.prisma.lineaWhatsapp.findUniqueOrThrow({ where: { id: lineaId } });
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
      nombrePerfil || nombreProvisional(telefono),
      telefono,
    );

    const conversacion = await this.obtenerOCrearConversacion(cliente.id, lineaId, linea.comercial);

    /* Contexto de campaña / anuncio de Meta (Click-to-WhatsApp Ads) */
    const esInstagram = Boolean(
      referral?.origenUrl?.toLowerCase().includes('instagram') ||
      referral?.origenTipo?.toLowerCase().includes('instagram'),
    );
    const origenLead: OrigenLead = referral
      ? (esInstagram ? OrigenLead.INSTAGRAM_LEAD_AD : OrigenLead.FACEBOOK_LEAD_AD)
      : OrigenLead.WHATSAPP_DIRECTO;

    if (linea.comercial && (referral?.titular || referral?.anuncioId || referral?.cuerpo)) {
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
            /* Los campos nuevos se suman sin migración —`datosExtra` es JSON— y
               los registros viejos simplemente no los traen: quien los lee ya
               los trata como opcionales. */
            campanaOrigen: {
              titular: referral.titular ?? null,
              anuncioId: referral.anuncioId ?? null,
              cuerpo: referral.cuerpo ?? null,
              origenUrl: referral.origenUrl ?? null,
              imagenUrl: referral.imagenUrl ?? null,
              mediaTipo: referral.mediaTipo ?? null,
              videoUrl: referral.videoUrl ?? null,
              saludo: referral.saludo ?? null,
              clickId: referral.clickId ?? null,
              fecha: new Date().toISOString(),
            },
          },
        },
      });
    }

    /* `conversacion.update` bumpea `updatedAt` — sin esto un mensaje entrante
       no subía el chat al tope del inbox (ordenado por updatedAt desc), y el
       agente podía no notar que había algo nuevo hasta revisar chat por chat. */
    let mensaje: Mensaje;
    try {
      mensaje = await this.prisma.$transaction(async tx => {
        const creado = await tx.mensaje.create({
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
            // El trabajo nace con el mensaje, incluso si R2/Meta no están configurados.
            ...(media ? { trabajoMedia: { create: { mediaId: media.mediaId } } } : {}),
          },
        });
        await tx.conversacion.update({
          where: { id: conversacion.id },
          data: { updatedAt: new Date(), esperandoRespuesta: true },
        });
        if (linea.comercial) await this.primerContacto.preparar(
          tx, conversacion.id, creado.id, origenLead, referral?.anuncioId,
        );
        return creado;
      });
    } catch (error) {
      // El índice resuelve también la carrera que pasó el precheck simultáneamente.
      if (whatsappMsgId && error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002') {
        const existente = await this.prisma.mensaje.findUnique({ where: { whatsappMsgId } });
        if (existente) return existente;
      }
      throw error;
    }

    // Ya quedó durable en la transacción. Este despertar solo reduce la latencia;
    // si el proceso muere aquí, el barrido de arranque retoma el trabajo.
    if (media) this.mediaEntrante.despertar();

    // El alta es independiente del aviso, pero su obligación ya está confirmada.
    // Si falla o el proceso termina, el barrido la completa sin otro webhook.
    await this.primerContacto.procesarUno(conversacion.id);

    /* Refresca el inbox de quien lo tenga abierto y avisa al teléfono de quien
       no. **Es el único sitio del módulo que manda notificación push**: aquí y
       solo aquí ha escrito una paciente. La dueña sale del cliente y no de la
       conversación: si el chat está en el pool, `agenteId` es null y el aviso
       va a todo el equipo. */
    this.gateway.notificarEntrante(conversacion.id, {
      clienteNombre: cliente.nombre,
      texto: contenido,
      agenteId: conversacion.agenteId,
    });

    /* Acuse fuera de horario. Sin `await`, como todo lo que habla con Meta: el
       webhook tiene que responder en milisegundos. */
    if (linea.comercial) void enSegundoPlano('acuse fuera de horario', this.logger, () =>
      this.responderFueraDeHorario(conversacion.id, cliente.telefono),
    );

    /* El clic en un botón del acuse hoy no disparaba nada más: el título
       quedaba en el chat como si el paciente lo hubiera escrito, y ahí se
       cortaba. Esto pide nombre y edad para que quien abra el chat después
       ya sepa con quién habla. */
    if (linea.comercial && esRespuestaBotonAcuse) {
      void enSegundoPlano('pedido de nombre y edad tras el acuse', this.logger, () =>
        this.pedirDatosDelPaciente(conversacion.id, cliente.telefono),
      );
    }

    return mensaje;
  }

  /**
   * Una conversación por paciente + línea. La reserva comercial nace en el
   * mismo INSERT; una conversación anterior nunca se rearma por un reintento.
   */
  private async obtenerOCrearConversacion(
    clienteId: string,
    lineaId: string,
    comercial: boolean,
  ): Promise<{ id: string; agenteId: string | null }> {
    const existente = await this.prisma.conversacion.findUnique({ where: { clienteId_lineaId: { clienteId, lineaId } } });
    if (existente) return existente;
    try {
      return await this.prisma.conversacion.create({
        data: {
          clienteId, lineaId,
          ...(comercial ? { primerContacto: { create: {} } } : {}),
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const yaCreada = await this.prisma.conversacion.findUnique({ where: { clienteId_lineaId: { clienteId, lineaId } } });
        if (yaCreada) return yaCreada;
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
        /* `true`, no `false`: el acuse NO es una respuesta. Si esto lo pusiera
           en `false`, todo lo que entra un fin de semana saldría de "Sin
           responder" y el lunes nadie sabría quién quedó esperando — el mismo
           caso que ya cubre `automatico` en `estaSinResponder()`. */
        data: { updatedAt: new Date(), esperandoRespuesta: true },
      }),
    ]);

    this.gateway.emitirActividad(conversacionId);
    return mensaje;
  }
}
