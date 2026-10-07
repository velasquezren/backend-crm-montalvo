import { LINEA_COMERCIAL_INICIAL, obtenerOCrearConversacion } from './acceso-conversacion';
import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Mensaje, MotivoAtencion, OrigenLead, Prisma } from '../../prisma/prisma-client';

import { CONFIRMACION_BAJA, esPedidoDeBaja } from './baja-promociones';
import { REABRIR } from './estado-conversacion';
import { CANDADO_AUTOMATICOS, esAvisoDeEmergencia, esPedidoDePersona, motivoDeRespuesta, registrarSolicitudAtencion } from './atencion-humana';
import { enSegundoPlano } from '../../common/fiabilidad/en-segundo-plano';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientesService, nombreProvisional } from '../clientes/clientes.service';
import { PrimerContactoService } from '../leads/primer-contacto.service';
import { datosOferta, flowDeCita, FlowPublicado, guardarRespuesta, interaccionesEnLinea, OfertaInteraccion, prepararOferta } from './interacciones-integracion';
import { MenuAtencionService } from '../menu-atencion/menu-atencion.service';
import { MensajePreparado } from '../../common/whatsapp/interacciones/mensaje-interactivo';
import {
  AccionMenu,
  accionDeSeleccion,
  MenuAtencion,
  mensajeDelMenu,
  mensajeDePromociones,
  orientacionDeEmergencia,
  pideMenu,
  seResuelveSola,
} from '../menu-atencion/menu-atencion';
import { AcuseAutomaticoService } from './acuse-automatico.service';
import { ConversacionesGateway } from './conversaciones.gateway';
import { DespachadorSalienteService } from './despachador-saliente.service';
import { MediaEntranteService, MediaEntrante } from './media-entrante.service';
import { CONTENIDO_PIN, TEXTO_UBICACION, UBICACION_CLINICA } from './ubicacion-clinica';
import { registrarComprobante } from './pagos-chat';
import { codigoEnTexto, HABLAR_CON_PERSONA, PAGAR_PROMOCION, TEXTO_COMPROBANTE_RECIBIDO, TEXTO_PERSONA_TARJETA } from './promocion-chat';
import { PromocionesChatService } from './promociones-chat.service';
import type { PromocionChat } from '../promociones/promociones.service';

/** No repetir el pin en la misma conversación antes de esto. */
const UBICACION_ESPERA_MS = 12 * 60 * 60 * 1000;
/** Si una persona escribió hace menos que esto, está atendiendo: no interrumpir. */
const PERSONA_ATENDIENDO_MS = 15 * 60 * 1000;
/**
 * El menú de atención se ofrece al empezar una conversación, no en cada
 * mensaje: no se repite si en este plazo ya se ofreció algo o una persona le
 * escribió. Es el plazo en que una conversación sigue «en curso».
 */
const MENU_ESPERA_MS = 24 * 60 * 60 * 1000;
/** Una confirmación u orientación no se repite si ya salió hace menos que esto. */
const RESPUESTA_REPETIDA_MS = 30 * 60 * 1000;

/**
 * Un automático: texto, una oferta interactiva que se guarda para correlacionar su
 * respuesta, o un texto con una imagen de R2 (el QR de pago).
 */
type Automatico = string | { oferta: OfertaInteraccion } | { texto: string; media: { key: string; mime: string; nombre: string } };

/** De dónde sale una oferta automática: el menú, o la tarjeta de una promoción. */
type OrigenOferta = { origen: 'MENU_ATENCION' } | { origen: 'PROMOCION'; promocionId: string };

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
    private readonly menus: MenuAtencionService,
    private readonly promocionesChat: PromocionesChatService,
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
    /**
     * true = el mensaje es el TOQUE de un botón —de una plantilla o de un
     * mensaje interactivo como el acuse—, no algo que la paciente escribió.
     * Ver `extraerRespuestaBoton` en el webhook.
     */
    esRespuestaBoton = false,
    lineaId = LINEA_COMERCIAL_INICIAL,
    interaccionOriginal?: unknown,
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

    const conversacion = await obtenerOCrearConversacion(this.prisma, cliente.id, lineaId, linea.comercial);

    /* Contexto de campaña / anuncio de Meta (Click-to-WhatsApp Ads) */
    const esInstagram = Boolean(
      referral?.origenUrl?.toLowerCase().includes('instagram') ||
      referral?.origenTipo?.toLowerCase().includes('instagram'),
    );
    const origenLead: OrigenLead = referral
      ? (esInstagram ? OrigenLead.INSTAGRAM_LEAD_AD : OrigenLead.FACEBOOK_LEAD_AD)
      : OrigenLead.WHATSAPP_DIRECTO;

    if (linea.comercial && (referral?.titular || referral?.anuncioId || referral?.cuerpo)) {
      await this.clientesService.registrarCampanaOrigen(cliente, referral, origenLead);
    }

    /* El menú de atención de la línea, si está encendido (y las interacciones
       también en ESTA línea: sin ellas no hay ofertas que correlacionar). */
    const interacciones = interaccionesEnLinea(lineaId);
    const menu = interacciones ? await this.menus.activoDe(lineaId) : null;

    /* `conversacion.update` bumpea `updatedAt` — sin esto un mensaje entrante
       no subía el chat al tope del inbox (ordenado por updatedAt desc), y el
       agente podía no notar que había algo nuevo hasta revisar chat por chat. */
    let mensaje: Mensaje;
    /* La solicitud de atención humana que nació con este mensaje, si nació. */
    let solicitud: MotivoAtencion | null = null;
    /* Lo que este mensaje pidió, aunque ya hubiera una solicitud viva: una
       emergencia avisa a todos aunque el chat ya estuviera esperando. */
    /* `as` y no anotación: se asignan dentro de la transacción y TypeScript, que
       no sigue esa asignación, las estrecharía a `null` para siempre. */
    let pedido = null as MotivoAtencion | null;
    /* La opción de nuestro menú que tocó, si la tocó. */
    let accion = null as AccionMenu | null;
    /* Tocó «Pagar ahora» en la tarjeta de esta promoción. */
    let pagarPromocion = null as string | null;
    /* La imagen o documento que mandó era el comprobante de un pago pendiente. */
    let comprobante = false;
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
        if (interaccionOriginal !== undefined && interacciones) {
          const resultado = await guardarRespuesta(tx, creado.id, conversacion.id, telefono, interaccionOriginal);
          if (linea.comercial && resultado.promocionId && resultado.seleccionId === PAGAR_PROMOCION && resultado.estado === 'CORRELACIONADA') {
            /* «Pagar ahora» de una tarjeta VIGENTE: se le manda el QR aunque una persona
               ya esté en el chat, porque es lo que ella acaba de pedir. Si hoy no se puede
               cobrar, se pide una persona después (`enviarPago`). Un toque a una tarjeta
               caducada sigue la regla de todos los toques tardíos: lo ve una persona. */
            pagarPromocion = resultado.promocionId;
          } else {
            /* Qué significa la opción según el menú de HOY; solo si estaba en
               nuestra oferta (`seleccionId` existe únicamente tras correlacionar). */
            /* Y solo de una oferta del MENÚ: el mismo `TALK_TO_HUMAN` en una
               plantilla de campaña pide una persona, pero no es un toque al menú. */
            accion = resultado.deMenu && resultado.seleccionId ? accionDeSeleccion(menu, resultado.seleccionId) : null;
            /* «Hablar con alguien» en NUESTRA tarjeta vigente: pide una persona como
               el menú, y recibe su confirmación (la del menú, o una propia). */
            if (resultado.promocionId && resultado.seleccionId === HABLAR_CON_PERSONA && resultado.estado === 'CORRELACIONADA') {
              const delMenu = accionDeSeleccion(menu, HABLAR_CON_PERSONA);
              accion = { tipo: 'PERSONA', confirmacion: (delMenu?.tipo === 'PERSONA' ? delMenu.confirmacion : null) ?? TEXTO_PERSONA_TARJETA };
            }
            /* Lo informativo (horarios, cómo llegar, promociones) se contesta solo
               siempre que ella lo toque en una oferta vigente, aunque ya espere a una
               persona: lo acaba de pedir ella, y su solicitud sigue como estaba. */
            const resuelveSola = seResuelveSola(accion);
            /* En la MISMA transacción: si el mensaje queda guardado, su solicitud
               también. Un refresco, una desconexión o un reinicio no la pierden. */
            pedido = motivoDeRespuesta(resultado, resuelveSola);
            /* Si hace falta una persona (menú caducado), no se contesta solo
               además: la decisión es una, la de `motivoDeRespuesta`. */
            if (resuelveSola && pedido) accion = null;
            if (pedido && await registrarSolicitudAtencion(tx, conversacion.id, pedido, creado.id, this.ahora())) solicitud = pedido;
          }
        } else if (!media && !esRespuestaBoton && interacciones) {
          /* Escribió, entera, una frase inequívoca: que es una emergencia, o que
             quiere hablar con una persona. La misma solicitud que el botón, en la
             misma transacción. Lo demás que escriba no genera nada: esto no
             clasifica mensajes, solo reconoce dos listas cerradas de frases. */
          pedido = esAvisoDeEmergencia(contenido) ? 'EMERGENCIA' : esPedidoDePersona(contenido) ? 'SOLICITUD_EXPLICITA' : null;
          if (pedido && await registrarSolicitudAtencion(tx, conversacion.id, pedido, creado.id, this.ahora())) solicitud = pedido;
        } else if (media && (media.tipo === 'IMAGEN' || media.tipo === 'DOCUMENTO') && await registrarComprobante(tx, conversacion.id, creado.id)) {
          /* Había un pago esperando su comprobante: esta foto o PDF lo es. Pasa a
             «Atención» para que una persona lo verifique, en la misma transacción. */
          comprobante = true;
          pedido = 'COMPROBANTE_PAGO';
          if (await registrarSolicitudAtencion(tx, conversacion.id, pedido, creado.id, this.ahora())) solicitud = pedido;
        }
        await tx.conversacion.update({
          where: { id: conversacion.id },
          /* Escribió ella: si la conversación estaba cerrada, se reabre. */
          data: { updatedAt: new Date(), esperandoRespuesta: true, ...REABRIR },
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
       solo aquí ha escrito una paciente. A quién le suena no se decide aquí:
       lo lee `LineasWhatsappService.audiencia` de la base, con la línea, la
       dueña y quién la silenció. */
    const emergencia = pedido === 'EMERGENCIA';
    this.gateway.notificarEntrante(conversacion.id, {
      clienteNombre: cliente.nombre,
      /* El título de un botón dice poco en el teléfono; lo que importa es que
         pidió a alguien. Es el mismo aviso, a las mismas personas. */
      texto: emergencia ? 'Indicó una EMERGENCIA'
        : solicitud === 'SOLICITUD_EXPLICITA' ? 'Pidió hablar con una persona'
        : solicitud === 'SOLICITUD_CITA' ? 'Envió una solicitud de cita'
        : comprobante ? 'Envió un comprobante de pago' : contenido,
      /* Una emergencia le suena a todos los que ven la línea, también a quien
         la silenció: el silencio es para el flujo normal, no para esto. */
      critica: emergencia,
    });

    /* Lo que dijo que es una emergencia recibe la orientación que aprobó la
       clínica, si existe —aunque haya escrito en vez de tocar el botón—. Sin
       texto configurado no se le manda nada inventado: la solicitud crítica ya
       está arriba de todo en «Atención». */
    const orientacion = emergencia ? (accion?.tipo === 'EMERGENCIA' ? accion.orientacion : orientacionDeEmergencia(menu)) : null;
    if (orientacion) {
      void enSegundoPlano('orientación de emergencia', this.logger, () =>
        this.responderTexto(conversacion.id, cliente.telefono, orientacion, { respetaPausa: false, noRepetir: true }),
      );
    }
    /* Mandó el comprobante: que sepa que llegó y que lo verifica una persona. */
    if (comprobante) {
      void enSegundoPlano('acuse de comprobante', this.logger, () =>
        /* Cada comprobante registrado es un evento propio (tras «pedir otro», el
           nuevo también merece su acuse); un webhook repetido ya no llega aquí. */
        this.responderTexto(conversacion.id, cliente.telefono, TEXTO_COMPROBANTE_RECIBIDO, { respetaPausa: false, noRepetir: false }),
      );
    }

    // Las selecciones nuevas son datos para la persona que atiende. Nunca
    // disparar automáticos/opt-out por títulos no confiables de un botón:
    // solo lo que el menú de HOY dice de una opción que estaba en nuestra oferta.
    if (interaccionOriginal !== undefined && interacciones) {
      const elegida = accion;
      if (elegida && elegida.tipo !== 'EMERGENCIA') {
        void enSegundoPlano('respuesta del menú de atención', this.logger, () =>
          this.responderSeleccion(conversacion.id, cliente.telefono, lineaId, elegida, menu, mensaje.id),
        );
      }
      const promocionAPagar = pagarPromocion;
      if (promocionAPagar) {
        void enSegundoPlano('pago de promoción', this.logger, () =>
          this.enviarPago(conversacion.id, cliente.telefono, lineaId, promocionAPagar, mensaje.id),
        );
      }
      return mensaje;
    }

    /* «No me interesa» en una promoción: se registra la baja y se confirma, y
       NADA más. Ni el acuse fuera de horario («te atendemos mañana») ni el
       pedido de nombre y edad tienen sentido para quien acaba de pedir que no
       le escriban. */
    if (esRespuestaBoton && esPedidoDeBaja(contenido)) {
      void enSegundoPlano('baja de promociones', this.logger, () =>
        this.confirmarBajaPromociones(conversacion.id, cliente.id, cliente.telefono),
      );
      return mensaje;
    }

    /* Respuestas automáticas: el acuse fuera de horario (solo línea comercial)
       y la ubicación si la paciente la pide (cualquier línea). Sin `await`,
       como todo lo que habla con Meta: el webhook tiene que responder en
       milisegundos. Van en orden y no en paralelo: el acuse mira si ya hubo un
       automático reciente, y el pin no debe contar como tal. */
    /* El enlace de la landing escribe el código de la promoción (`PRM-…`). */
    const codigo = linea.comercial && !media && !esRespuestaBoton ? codigoEnTexto(contenido) : null;
    void enSegundoPlano('respuestas automáticas', this.logger, async () => {
      /* Vino por una promoción: queda atribuida y recibe su tarjeta, que hace de
         menú y de acuse a la vez. */
      const tarjeta = codigo ? await this.atenderCodigo(conversacion.id, cliente.id, cliente.telefono, lineaId, codigo) : false;
      /* Quien acaba de pedir algo ya tiene una persona en camino. */
      /* Escribió «menú»: se le muestra aunque la conversación esté en curso. */
      const ofrecido = !tarjeta && menu && !pedido && !esRespuestaBoton
        ? await this.ofrecerMenu(conversacion.id, cliente.telefono, menu, { aPedido: !media && pideMenu(contenido) })
        : false;
      /* Cuando el menú sale, ES el acuse: dos automáticos al mismo mensaje se
         leen como un sistema roto. Cuando no sale (la conversación está en curso),
         el acuse fuera de horario funciona como siempre. */
      if (linea.comercial && !ofrecido && !tarjeta) await this.responderFueraDeHorario(conversacion.id, cliente.telefono);
      if (!media) await this.compartirUbicacionSiLaPiden(conversacion.id, cliente.telefono, contenido);
    });

    /* El clic en un botón del acuse hoy no disparaba nada más: el título
       quedaba en el chat como si el paciente lo hubiera escrito, y ahí se
       cortaba. Esto pide nombre y edad para que quien abra el chat después
       ya sepa con quién habla. */
    if (linea.comercial && esRespuestaBoton) {
      void enSegundoPlano('pedido de nombre y edad tras el acuse', this.logger, () =>
        this.pedirDatosDelPaciente(conversacion.id, cliente.telefono),
      );
    }

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
      const [mensaje] = await this.guardarMensajeAutomatico(conversacionId, [acuse.texto], async tx =>
        !!(await tx.mensaje.findFirst({
          /* La ubicación también es automática, pero no es un acuse: pedirla por
             la tarde no puede dejar sin aviso a quien escribe esa noche. */
          /* Un MENÚ que no salió no cuenta: la paciente no lo recibió y el acuse es
             su reemplazo. Un acuse que falló sí cuenta: lo reintenta el barrido, y
             contarlo como «no hecho» crearía uno nuevo por mensaje (y varios
             reintentos llegarían a la vez). */
          where: {
            conversacionId, automatico: true, createdAt: { gte: desde }, contenido: { notIn: [TEXTO_UBICACION, CONTENIDO_PIN] },
            NOT: { estadoEnvio: 'FALLIDO', interaccion: { isNot: null } },
          },
          select: { id: true },
        })),
      ) ?? [];
      if (!mensaje || !(await this.sigueSinPausa(conversacionId, [mensaje]))) return;

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
  /**
   * Registra la baja de promociones y se la confirma a la paciente. Solo la
   * primera vez: tocar «No me interesa» de nuevo no vuelve a contestar. La
   * confirmación es un mensaje libre: ella acaba de escribir, la ventana de 24
   * horas está abierta.
   */
  private async confirmarBajaPromociones(conversacionId: string, clienteId: string, telefono: string): Promise<void> {
    try {
      if (!(await this.clientesService.registrarBajaPromociones(clienteId))) return;
      /* Responde a lo que ella pidió, una sola vez: no es automatización que
         deba callarse ante una solicitud de atención. */
      const [mensaje] = await this.guardarMensajeAutomatico(conversacionId, [CONFIRMACION_BAJA], async () => false, { respetaPausa: false }) ?? [];
      if (mensaje) await this.despachador.texto({ mensajeId: mensaje.id, conversacionId, telefono }, CONFIRMACION_BAJA);
    } catch (error) {
      /* La entrada ya está guardada; lo que falle aquí no puede tumbarla. */
      this.logger.error('No se pudo registrar o confirmar la baja de promociones', error);
    }
  }

  private async pedirDatosDelPaciente(conversacionId: string, telefono: string): Promise<void> {
    const texto = this.acuse.decidirPedidoDatos();
    if (!texto) return; // apagado mientras no exista AUTORESPUESTA_PEDIDO_DATOS

    try {
      const [mensaje] = await this.guardarMensajeAutomatico(conversacionId, [texto], async tx =>
        !!(await tx.mensaje.findFirst({ where: { conversacionId, automatico: true, contenido: texto }, select: { id: true } })),
      ) ?? [];
      if (!mensaje || !(await this.sigueSinPausa(conversacionId, [mensaje]))) return;
      await this.despachador.texto({ mensajeId: mensaje.id, conversacionId, telefono }, texto);
    } catch (error) {
      /* Mismo criterio que el acuse: nunca tumba la entrada del mensaje del
         paciente, que ya está guardada. */
      this.logger.error('No se pudo enviar el pedido de nombre y edad tras el clic en el acuse', error);
    }
  }

  /**
   * Si la paciente pregunta dónde queda la clínica, le manda el pin de
   * ubicación precedido de una línea que avisa que enseguida la atiende una
   * persona. No es un bot: responde a esa sola intención (ver
   * `ubicacion-clinica.ts`).
   *
   * No lo hace si una persona le escribió en los últimos minutos —está
   * atendiendo y el pin automático interrumpiría— ni si ya se lo mandó hace
   * poco: preguntar dos veces seguidas no merece dos mapas.
   */
  private async compartirUbicacionSiLaPiden(conversacionId: string, telefono: string, contenido: string): Promise<void> {
    if (!this.acuse.decidirUbicacion(contenido)) return;

    try {
      const ahora = this.ahora().getTime();
      const filas = await this.guardarMensajeAutomatico(conversacionId, [TEXTO_UBICACION, CONTENIDO_PIN], async tx => {
        const [yaCompartida, atendiendo] = await Promise.all([
          tx.mensaje.findFirst({
            where: { conversacionId, automatico: true, contenido: CONTENIDO_PIN, createdAt: { gte: new Date(ahora - UBICACION_ESPERA_MS) } },
            select: { id: true },
          }),
          tx.mensaje.findFirst({
            where: { conversacionId, direccion: 'SALIENTE', automatico: false, createdAt: { gte: new Date(ahora - PERSONA_ATENDIENDO_MS) } },
            select: { id: true },
          }),
        ]);
        return !!(yaCompartida || atendiendo);
      });
      if (!filas || !(await this.sigueSinPausa(conversacionId, filas))) return;
      await this.despacharUbicacion(conversacionId, telefono, filas, TEXTO_UBICACION);
    } catch (error) {
      /* Mismo criterio que el acuse: nunca tumba la entrada del mensaje. */
      this.logger.error('No se pudo compartir la ubicación de la clínica', error);
    }
  }

  /**
   * Ofrece el menú de atención al empezar una conversación. No lo repite si en
   * las últimas `MENU_ESPERA_MS` ya se le ofreció algo o una persona le
   * escribió: entonces la conversación está en curso y el menú estorbaría.
   * Devuelve si lo ofreció.
   */
  private async ofrecerMenu(conversacionId: string, telefono: string, menu: MenuAtencion, { aPedido = false } = {}): Promise<boolean> {
    /* La opción «Promociones» solo sale si hoy hay alguna publicada para WhatsApp. */
    const elMenu = async () => mensajeDelMenu(menu, {
      hayPromociones: menu.opciones.some(o => o.tipo === 'PROMOCIONES') && (await this.promocionesChat.hayParaMenu()),
    });
    /* Lo pidió ella escribiendo «menú»: sale siempre, aunque espere a una persona. */
    if (aPedido) return this.enviarOfertaAutomatica(conversacionId, telefono, await elMenu(), { origen: 'MENU_ATENCION' }, async () => false, { respetaPausa: false });
    const desde = new Date(this.ahora().getTime() - MENU_ESPERA_MS);
    const enCurso = async (db: Prisma.TransactionClient) => {
      const [ofrecido, persona] = await Promise.all([
        db.mensaje.findFirst({ where: { conversacionId, direccion: 'SALIENTE', automatico: true, interaccion: { isNot: null }, createdAt: { gte: desde } }, select: { id: true } }),
        db.mensaje.findFirst({ where: { conversacionId, direccion: 'SALIENTE', automatico: false, createdAt: { gte: desde } }, select: { id: true } }),
      ]);
      return !!(ofrecido || persona);
    };
    /* La mayoría de los mensajes llegan con la conversación en curso: se mira sin
       candado y solo se toma el candado (que vuelve a mirar) si parece que toca. */
    if (await enCurso(this.prisma)) return false;
    return this.enviarOfertaAutomatica(conversacionId, telefono, await elMenu(), { origen: 'MENU_ATENCION' }, enCurso);
  }

  /**
   * Escribió con el código de una promoción. La promoción queda atribuida a su
   * lead aunque no se le pueda responder (bandeja de interacciones apagada) y,
   * si se puede, recibe su tarjeta. Devuelve si salió la tarjeta. Un código de
   * una promoción que ya no está visible no responde nada: lo ve una persona.
   */
  private async atenderCodigo(conversacionId: string, clienteId: string, telefono: string, lineaId: string, codigo: string): Promise<boolean> {
    const promocion = await this.promocionesChat.porCodigo(codigo);
    if (!promocion) return false;
    if (await this.promocionesChat.atribuir(clienteId, promocion.id)) this.gateway.emitirActividad(conversacionId);
    if (!interaccionesEnLinea(lineaId)) return false;
    return this.enviarTarjeta(conversacionId, telefono, lineaId, promocion);
  }

  /**
   * Lo que se iba a contestar solo ya no se puede (la promoción dejó de estar
   * visible, no hay QR…): en vez de dejarla sin respuesta, lo ve una persona.
   */
  private async pedirRevision(conversacionId: string, mensajeId: string): Promise<void> {
    await this.prisma.$transaction(tx => registrarSolicitudAtencion(tx, conversacionId, 'REVISION', mensajeId, this.ahora()));
    this.gateway.emitirActividad(conversacionId);
  }

  /** La tarjeta de una promoción, una vez cada 30 min aunque la pida dos veces. */
  private async enviarTarjeta(conversacionId: string, telefono: string, lineaId: string, promocion: PromocionChat): Promise<boolean> {
    const tarjeta = await this.promocionesChat.tarjeta(lineaId, promocion);
    if (!tarjeta) return false;
    const desde = new Date(this.ahora().getTime() - RESPUESTA_REPETIDA_MS);
    /* La pidió ella (escribió el código o la eligió de la lista): sale aunque espere a una persona. */
    return this.enviarOfertaAutomatica(conversacionId, telefono, tarjeta, { origen: 'PROMOCION', promocionId: promocion.id }, async tx =>
      !!(await tx.mensaje.findFirst({ where: { conversacionId, automatico: true, contenido: tarjeta.cuerpo, createdAt: { gte: desde } }, select: { id: true } })),
      { respetaPausa: false },
    );
  }

  /**
   * «Pagar ahora»: el QR de la línea con el monto y qué hacer después. Si hoy no
   * se puede cobrar por chat (promoción vencida, sin precio, línea sin QR vigente)
   * no se le manda nada inventado: la conversación pasa a «Atención».
   */
  private async enviarPago(conversacionId: string, telefono: string, lineaId: string, promocionId: string, mensajeId: string): Promise<void> {
    try {
      const inicio = await this.promocionesChat.iniciar(conversacionId, lineaId, promocionId);
      /* Su comprobante de esta promoción ya se está verificando: no se le pide otra vez. */
      if (inicio === 'EN_VERIFICACION') return;
      if (!inicio) {
        await this.pedirRevision(conversacionId, mensajeId);
        return;
      }
      const desde = new Date(this.ahora().getTime() - RESPUESTA_REPETIDA_MS);
      const media = { key: inicio.imagen.clave, mime: inicio.imagen.mime, nombre: 'QR de pago' };
      /* Responde a lo que ella pidió: sale aunque el chat espere a una persona. */
      const [fila] = await this.guardarMensajeAutomatico(conversacionId, [{ texto: inicio.texto, media }], async tx =>
        !!(await tx.mensaje.findFirst({ where: { conversacionId, automatico: true, contenido: inicio.texto, createdAt: { gte: desde } }, select: { id: true } })),
        { respetaPausa: false },
      ) ?? [];
      if (fila) await this.despachador.texto({ mensajeId: fila.id, conversacionId, telefono }, inicio.texto, media);
    } catch (error) {
      this.logger.error('No se pudo enviar el QR de pago', error);
    }
  }

  /**
   * Una oferta del menú (el menú o la lista de promociones): se guarda bajo el
   * candado de automáticos, se retira si entretanto alguien pidió una persona y
   * se despacha. Devuelve si SALIÓ: un menú que Meta rechazó no cuenta como
   * acuse, y entonces el acuse fuera de horario sale como siempre.
   */
  private async enviarOfertaAutomatica(
    conversacionId: string, telefono: string, mensaje: MensajePreparado, origen: OrigenOferta, yaHecho: (tx: Prisma.TransactionClient) => Promise<boolean>,
    { respetaPausa = true } = {},
  ): Promise<boolean> {
    try {
      const filas = await this.guardarMensajeAutomatico(conversacionId, [{ oferta: { ...prepararOferta(mensaje, telefono), ...origen } }], yaHecho, { respetaPausa });
      if (!filas || (respetaPausa && !(await this.sigueSinPausa(conversacionId, filas)))) return false;
      await this.despachador.interaccion({ mensajeId: filas[0].id, conversacionId, telefono });
      const enviada = await this.prisma.mensaje.findUnique({ where: { id: filas[0].id }, select: { estadoEnvio: true } });
      return enviada?.estadoEnvio !== 'FALLIDO';
    } catch (error) {
      /* Nunca tumba la entrada del mensaje, que ya está guardada. */
      this.logger.error('No se pudo enviar el menú de atención', error);
      return false;
    }
  }

  /**
   * Lo que hace una opción del menú que la paciente tocó. Las que piden una
   * persona ya dejaron su solicitud en la transacción; aquí solo sale la
   * confirmación, si la clínica la escribió. Las que se contestan solas salen
   * aquí aunque espere a una persona: las acaba de pedir ella.
   */
  private async responderSeleccion(conversacionId: string, telefono: string, lineaId: string, accion: AccionMenu, menu: MenuAtencion | null, mensajeId: string): Promise<void> {
    if (accion.tipo === 'PROMOCIONES' || accion.tipo === 'PROMOCION') {
      const linea = await this.prisma.lineaWhatsapp.findUnique({ where: { id: lineaId }, select: { comercial: true } });
      if (!linea?.comercial) { await this.pedirRevision(conversacionId, mensajeId); return; }
    }
    switch (accion.tipo) {
      case 'CITA': {
        /* Si la WABA de la línea tiene publicado el Flow de solicitud de cita, se lo
           abre: especialidad, cuándo y horario llegan al chat ordenados. La
           solicitud ya nació con el toque (si no completa el Flow, igual la ve una
           persona); el Flow solo la completa. Sin Flow, la confirmación de siempre. */
        const linea = await this.prisma.lineaWhatsapp.findUnique({ where: { id: lineaId }, select: { wabaId: true } });
        const flow = flowDeCita(linea?.wabaId);
        if (flow) { await this.enviarFlowDeCita(conversacionId, telefono, flow, accion.confirmacion); return; }
        if (accion.confirmacion) await this.responderTexto(conversacionId, telefono, accion.confirmacion, { respetaPausa: false, noRepetir: true });
        return;
      }
      case 'PERSONA':
        /* Responde a lo que ella pidió, una vez: no es automatización que deba
           callarse ante la solicitud que esa misma opción acaba de crear. */
        if (accion.confirmacion) await this.responderTexto(conversacionId, telefono, accion.confirmacion, { respetaPausa: false, noRepetir: true });
        return;
      case 'RESPUESTA':
        /* Si la vuelve a pedir, se le vuelve a responder: la pidió ella. */
        await this.responderTexto(conversacionId, telefono, accion.texto, { respetaPausa: false, noRepetir: false });
        return;
      case 'UBICACION':
        await this.enviarUbicacion(conversacionId, telefono, accion.texto);
        return;
      case 'PROMOCIONES': {
        /* Si entre el menú y el toque dejó de haber promociones publicadas, no se la
           deja sin respuesta: lo ve una persona. */
        const lista = menu ? mensajeDePromociones(menu, await this.promocionesChat.paraMenu()) : null;
        if (lista) await this.enviarOfertaAutomatica(conversacionId, telefono, lista, { origen: 'MENU_ATENCION' }, async () => false, { respetaPausa: false });
        else await this.pedirRevision(conversacionId, mensajeId);
        return;
      }
      case 'PROMOCION': {
        /* Eligió una de la lista: su tarjeta (precio, condiciones, pagar). Si dejó
           de estar visible entre la lista y el toque, lo ve una persona. */
        const promocion = await this.promocionesChat.porId(accion.promocionId);
        if (promocion) await this.enviarTarjeta(conversacionId, telefono, lineaId, promocion);
        else await this.pedirRevision(conversacionId, mensajeId);
        return;
      }
      case 'EMERGENCIA':
        /* Ya tuvo su orientación. */
        return;
    }
  }

  /**
   * El Flow de solicitud de cita, como respuesta a «Solicitar una cita»: sale
   * aunque el chat espere a una persona (esa espera la creó este mismo toque) y
   * una sola vez cada 30 min. Es una oferta de UN uso (sin `origen`): completarlo
   * dos veces deja la segunda respuesta como `DUPLICADA`.
   */
  private async enviarFlowDeCita(conversacionId: string, telefono: string, flow: FlowPublicado, confirmacion: string | null): Promise<void> {
    try {
      const cuerpo = confirmacion ?? 'Cuéntanos para qué es la cita y cuándo te queda mejor. Una persona del equipo te escribirá para confirmarla.';
      const oferta = prepararOferta(
        { tipo: 'flow', cuerpo, cta: 'Solicitar cita', flowId: flow.id, modo: 'published', inicio: { accion: 'navigate', pantalla: flow.pantalla } },
        telefono,
      );
      const desde = new Date(this.ahora().getTime() - RESPUESTA_REPETIDA_MS);
      const [fila] = await this.guardarMensajeAutomatico(conversacionId, [{ oferta }], async tx =>
        !!(await tx.mensaje.findFirst({ where: { conversacionId, automatico: true, contenido: cuerpo, interaccion: { isNot: null }, createdAt: { gte: desde } }, select: { id: true } })),
        { respetaPausa: false },
      ) ?? [];
      if (fila) await this.despachador.interaccion({ mensajeId: fila.id, conversacionId, telefono });
    } catch (error) {
      /* Que no se quede sin respuesta: la confirmación de siempre. */
      this.logger.error('No se pudo enviar el Flow de solicitud de cita', error);
      if (confirmacion) await this.responderTexto(conversacionId, telefono, confirmacion, { respetaPausa: false, noRepetir: true });
    }
  }

  /**
   * Un texto del menú o una confirmación. Con `respetaPausa: false` es la
   * respuesta a lo que ella acaba de pedir (confirmación, orientación de
   * emergencia) y sale aunque el chat espere a una persona. `noRepetir`: no
   * vuelve a salir el mismo texto antes de `RESPUESTA_REPETIDA_MS` (un segundo
   * toque a «Hablar con una persona» no merece una segunda confirmación; un
   * segundo «Horarios» sí merece la respuesta).
   */
  private async responderTexto(
    conversacionId: string, telefono: string, texto: string, { respetaPausa, noRepetir }: { respetaPausa: boolean; noRepetir: boolean },
  ): Promise<void> {
    try {
      const desde = new Date(this.ahora().getTime() - RESPUESTA_REPETIDA_MS);
      const [mensaje] = await this.guardarMensajeAutomatico(conversacionId, [texto], async tx =>
        noRepetir && !!(await tx.mensaje.findFirst({ where: { conversacionId, automatico: true, contenido: texto, createdAt: { gte: desde } }, select: { id: true } })),
        { respetaPausa },
      ) ?? [];
      if (!mensaje || (respetaPausa && !(await this.sigueSinPausa(conversacionId, [mensaje])))) return;
      await this.despachador.texto({ mensajeId: mensaje.id, conversacionId, telefono }, texto);
    } catch (error) {
      this.logger.error('No se pudo enviar la respuesta del menú de atención', error);
    }
  }

  /** «Ubicación» del menú: una línea opcional y el mapa. Pedida, no detectada. */
  private async enviarUbicacion(conversacionId: string, telefono: string, texto: string | null): Promise<void> {
    try {
      /* La pidió ella tocando «Cómo llegar»: sale aunque espere a una persona. */
      const filas = await this.guardarMensajeAutomatico(conversacionId, texto ? [texto, CONTENIDO_PIN] : [CONTENIDO_PIN], async () => false, { respetaPausa: false });
      if (!filas) return;
      await this.despacharUbicacion(conversacionId, telefono, filas, texto);
    } catch (error) {
      this.logger.error('No se pudo enviar la ubicación del menú de atención', error);
    }
  }

  /** Despacha lo que dejó guardado un envío de ubicación: el texto previo (si hay) y el pin, en ese orden. */
  private async despacharUbicacion(conversacionId: string, telefono: string, filas: readonly Mensaje[], texto: string | null): Promise<void> {
    const pin = filas[filas.length - 1];
    if (texto) await this.despachador.texto({ mensajeId: filas[0].id, conversacionId, telefono }, texto);
    await this.despachador.ubicacion({ mensajeId: pin.id, conversacionId, telefono }, UBICACION_CLINICA, CONTENIDO_PIN);
  }

  /**
   * Guarda respuestas automáticas —SALIENTE, `automatico: true`— y bumpea la
   * conversación, **si `yaHecho` dice que todavía no tocan**. Devuelve las
   * filas en el orden de `contenidos`, o `null` si no guardó nada.
   *
   * La pregunta y la escritura van bajo un candado de Postgres por
   * conversación, y ese es el punto. Antes eran «leer y luego escribir»: dos
   * webhooks casi simultáneos del mismo paciente —Meta entrega en paralelo—
   * leían los dos «todavía no» y el paciente recibía dos acuses o dos mapas.
   * Con el candado, el segundo espera a que el primero confirme y ya ve sus
   * filas. Un solo candado para todos los automáticos de la conversación: el
   * acuse mira lo que guarda la ubicación. El despacho a Meta va DESPUÉS, fuera
   * de la transacción: el candado no debe quedar tomado durante la red.
   */
  private async guardarMensajeAutomatico(
    conversacionId: string,
    contenidos: readonly Automatico[],
    yaHecho: (tx: Prisma.TransactionClient) => Promise<boolean>,
    { respetaPausa = true } = {},
  ): Promise<Mensaje[] | null> {
    const filas = await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${conversacionId}, ${CANDADO_AUTOMATICOS}))::text`;
      /* Bajo el MISMO candado que toma la solicitud de atención humana: o el
         automático se guardó antes de que ella pidiera una persona, o ve la
         pausa y no se guarda. */
      if (respetaPausa && await automatizacionPausada(tx, conversacionId)) return null;
      if (await yaHecho(tx)) return null;

      /* Instantes distintos a propósito: el hilo ordena por `createdAt` y el
         aviso tiene que quedar antes que el pin. */
      const base = Date.now();
      const creadas: Mensaje[] = [];
      for (const [i, item] of contenidos.entries()) {
        /* Una oferta se guarda con su interacción, igual que la de una agente:
           así su respuesta se correlaciona y el despachador la reconstruye tras
           un reinicio. Nace FALLIDA y con intento ya: `interaccion()` la reclama. */
        const oferta = typeof item === 'object' && 'oferta' in item ? item.oferta : null;
        const media = typeof item === 'object' && 'media' in item ? item.media : null;
        const clientMessageId = randomUUID();
        creadas.push(await tx.mensaje.create({
          data: {
            conversacionId,
            direccion: 'SALIENTE',
            contenido: typeof item === 'string' ? item : 'oferta' in item ? item.oferta.mensaje.cuerpo : item.texto,
            /* Una imagen de R2 (el QR): el hilo la muestra con su URL firmada y el
               despachador la manda como imagen con este texto de pie. */
            ...(media ? { tipo: media.mime.startsWith('image/') ? 'IMAGEN' : 'DOCUMENTO', mediaKey: media.key, mediaMime: media.mime, mediaNombre: media.nombre } : {}),
            /* La marca que impide que esto tape la conversación en el inbox —
               ver el comentario del campo en schema.prisma. */
            automatico: true,
            createdAt: new Date(base + i),
            ...(oferta
              ? { estadoEnvio: 'FALLIDO', proximoIntento: new Date(), clientMessageId, interaccion: { create: datosOferta(oferta, clientMessageId) } }
              : { estadoEnvio: 'ENVIADO' }),
          },
        }));
      }
      await tx.conversacion.update({
        where: { id: conversacionId },
        /* `true`, no `false`: el acuse NO es una respuesta. Si esto lo pusiera
           en `false`, todo lo que entra un fin de semana saldría de "Sin
           responder" y el lunes nadie sabría quién quedó esperando — el mismo
           caso que ya cubre `automatico` en `estaSinResponder()`. */
        data: { updatedAt: new Date(), esperandoRespuesta: true },
      });
      return creadas;
    });

    if (filas) this.gateway.emitirActividad(conversacionId);
    return filas;
  }

  /**
   * La última comprobación, justo antes de hablar con Meta. Entre guardar el
   * automático y despacharlo cabe una solicitud de atención —la paciente toca
   * «Hablar con recepción» mientras su mensaje anterior todavía se procesa—.
   * Si eso pasó, el automático se retira sin salir: ninguna respuesta tardía
   * llega después de que pidió una persona.
   */
  private async sigueSinPausa(conversacionId: string, filas: readonly Mensaje[]): Promise<boolean> {
    if (!(await automatizacionPausada(this.prisma, conversacionId))) return true;
    await this.prisma.mensaje.deleteMany({ where: { id: { in: filas.map(f => f.id) }, conversacionId, automatico: true } });
    this.gateway.emitirActividad(conversacionId);
    return false;
  }
}

async function automatizacionPausada(db: Prisma.TransactionClient, conversacionId: string): Promise<boolean> {
  const fila = await db.conversacion.findUnique({ where: { id: conversacionId }, select: { automatizacionPausadaEn: true } });
  return Boolean(fila?.automatizacionPausadaEn);
}
