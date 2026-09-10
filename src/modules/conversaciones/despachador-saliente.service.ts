import { Injectable, Logger } from '@nestjs/common';

import { R2Service } from '../../common/storage/r2.service';
import {
  ContenidoMensaje,
  ResultadoEnvio,
  WhatsappCloudService,
} from '../../common/whatsapp/whatsapp-cloud.service';
import { Prisma } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import { ConversacionesGateway } from './conversaciones.gateway';

/**
 * A quién y sobre qué fila va el envío.
 *
 * Va agrupado y no como tres parámetros sueltos a propósito: `mensajeId`,
 * `conversacionId` y `telefono` son los tres `string`, y cruzarlos en una
 * llamada compila igual de bien pero manda el mensaje al paciente equivocado.
 */
export interface Destino {
  mensajeId: string;
  conversacionId: string;
  telefono: string;
  /**
   * True cuando quien despacha es el barrido de reintentos, que YA agendó el
   * siguiente turno al reclamar la fila. Sin esta marca, el despachador
   * volvería a agendar desde cero en cada vuelta y el backoff no crecería
   * nunca: un mensaje muerto se reintentaría cada minuto para siempre.
   */
  reintento?: boolean;
}

/** Lo que hace falta para armar un `template` de Meta. */
export interface PlantillaADespachar {
  plantilla: string;
  idioma: string;
  parametros?: string[];
}

/**
 * Empuja hacia Meta un mensaje **que ya está guardado** y anota lo que contestó.
 *
 * La frontera es esa: cuando algo llega aquí, la fila ya existe y el agente ya
 * la ve en pantalla. Por eso todos los caminos terminan igual, en
 * `registrarResultadoEnvio`, y un fallo de Meta marca el tick en FALLIDO sin
 * tumbar la petición que ya devolvió 200.
 *
 * Lo que **sí** lanza es la anotación: `registrarResultadoEnvio` escribe en la
 * base, y si la base no responde el rechazo sale de aquí. Decía "ninguno lanza"
 * y no era cierto —F06 lo reprodujo—. Se deja así a propósito: quien despacha
 * el acuse automático espera el resultado dentro de su propio try/catch y
 * necesita enterarse. Los dos llamadores que lo disparan sin esperar lo
 * envuelven en `enSegundoPlano`.
 *
 * Antes esto vivía suelto dentro de `ConversacionesService`, mezclado con las
 * lecturas del inbox y las reglas de visibilidad. Separarlo deja una regla fácil
 * de sostener: **lo que habla con Meta al enviar está todo aquí y en ningún otro
 * sitio.**
 */
@Injectable()
export class DespachadorSalienteService {
  private readonly logger = new Logger(DespachadorSalienteService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: ConversacionesGateway,
    private readonly r2: R2Service,
    private readonly whatsapp: WhatsappCloudService,
  ) {}

  /** Texto del agente, con adjunto opcional guardado en R2. */
  async texto(destino: Destino, contenido: string, mediaKey?: string): Promise<void> {
    /* Con adjunto se firma una URL NUEVA aquí mismo. Reutilizar la que devolvió
       la subida sería jugársela: si el mensaje se reintenta pasados 15 minutos,
       Meta descargaría un enlace ya caducado y el paciente no recibiría nada. */
    const contenidoMeta = mediaKey
      ? await this.contenidoDesdeMedia(mediaKey, contenido)
      : contenidoSegunTexto(contenido);

    if (!contenidoMeta) {
      /* No se pudo firmar la media: no llegó a salir nada, y consta. */
      await this.registrarResultadoEnvio(destino, {
        estado: 'NO_SALIO',
        motivo: 'No se pudo firmar la media del adjunto',
      });
      return;
    }

    await this.registrarResultadoEnvio(
      destino,
      await this.whatsapp.enviar(destino.telefono, contenidoMeta, destino.mensajeId),
    );
  }

  /** Acuse con botonera de respuesta rápida. Degrada a texto plano si Meta lo rechaza. */
  async botones(destino: Destino, texto: string, botones: string[]): Promise<void> {
    const resultado = await this.whatsapp.enviar(
      destino.telefono,
      {
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
      },
      destino.mensajeId,
    );

    if (resultado.estado !== 'NO_SALIO') {
      /* ENVIADO se anota con su id; INCIERTO se anota como incierto y lo
         resolverá el `statuses`. Degradar a texto plano un envío que quizá SÍ
         salió le mandaría el acuse dos veces a la paciente. */
      await this.registrarResultadoEnvio(destino, resultado);
      return;
    }

    /* Meta rechaza un interactivo malformado ENTERO. Antes de dejar al paciente
       sin nada, se reintenta como texto plano: un acuse feo es mejor que ninguno.
       Solo aquí, donde consta que no salió nada. */
    this.logger.warn('El acuse con botones no salió; se reintenta como texto plano');
    await this.texto(destino, texto);
  }

  /** Plantilla aprobada — el único camino fuera de la ventana de 24 h. */
  async plantilla(destino: Destino, dto: PlantillaADespachar): Promise<void> {
    /* El cuerpo solo se incluye si la plantilla tiene variables; una plantilla
       sin variables con un `components` vacío es rechazada por Meta. */
    const componentes =
      dto.parametros && dto.parametros.length > 0
        ? [{ type: 'body', parameters: dto.parametros.map(text => ({ type: 'text', text })) }]
        : undefined;

    const resultado = await this.whatsapp.enviar(
      destino.telefono,
      {
        type: 'template',
        template: {
          name: dto.plantilla,
          language: { code: dto.idioma },
          ...(componentes ? { components: componentes } : {}),
        },
      },
      destino.mensajeId,
    );

    /* `false`: una plantilla fallida no se reintenta sola. La fila guarda el
       texto compuesto, no el nombre ni los parámetros, así que el barrido no
       tendría con qué rearmarla — y mandarla como texto plano es justo lo que
       Meta rechaza fuera de la ventana de 24 h, que es cuando se usan plantillas. */
    await this.registrarResultadoEnvio(destino, resultado, false);
  }

  /** Arma el adjunto para Meta a partir de la clave de R2, firmando al vuelo. */
  private async contenidoDesdeMedia(
    mediaKey: string,
    caption: string,
  ): Promise<ContenidoMensaje | null> {
    const url = await this.r2.urlFirmada(mediaKey);
    if (!url) {
      this.logger.error(`No se pudo firmar la media ${mediaKey}; el mensaje queda FALLIDO`);
      return null;
    }
    return /\.pdf(\?.*)?$/i.test(mediaKey)
      ? { type: 'document', document: { link: url, filename: caption || 'Documento.pdf' } }
      : { type: 'image', image: { link: url } };
  }

  /**
   * Anota en el mensaje lo que pasó con el envío.
   *
   * Lo comparten los tres caminos (texto, plantilla y botones). Antes recibía
   * `string | null` y ese `null` valía por igual para "Meta lo rechazó" y para
   * "se cayó la red y no sé si llegó": los dos acababan en FALLIDO. El segundo
   * es el que hacía daño — la agente lo reintentaba a mano y la paciente podía
   * recibirlo dos veces—, así que ahora se anota INCIERTO y no se reintenta
   * nada por su cuenta: lo resuelve el `statuses` de Meta, que vuelve con
   * `biz_opaque_callback_data`. Ver `resultado-de-envio-desconocido.spec.ts`.
   *
   * En los tres casos se avisa por WebSocket, para que el tick cambie en
   * pantalla sin que el agente recargue.
   */
  private async registrarResultadoEnvio(
    { mensajeId, conversacionId, reintento }: Destino,
    resultado: ResultadoEnvio,
    agendable = true,
  ): Promise<void> {
    /*
     * `updateMany` y no `update` porque `update` LANZA si la fila ya no está, y
     * eso convertiría un caso NORMAL —la conversación borrada mientras Meta
     * contestaba— en un error. Que es distinto de tolerar un fallo de base:
     * eso lo cubre el `enSegundoPlano` del llamador desde F06, no este cambio.
     *
     * Y la fila puede no estar: entre que el mensaje se guarda y que Meta
     * contesta (300-900 ms, a veces más) alguien pudo borrar la conversación,
     * que arrastra sus mensajes en cascada. `updateMany` afecta cero filas y
     * sigue, que es exactamente lo correcto para una anotación en segundo
     * plano — el mismo criterio que ya usa la reclamación del pool.
     *
     * No es teórico: la suite de integración lo provocaba de verdad. Once de
     * sus tests mandan un mensaje sin esperar al despacho, el `afterEach`
     * limpiaba las tablas con el envío todavía en vuelo, y el rechazo caía
     * sobre el test siguiente — un fallo intermitente (1 de cada 4 corridas)
     * que acusaba a una prueba que no tenía nada que ver.
     */
    if (resultado.estado !== 'ENVIADO') {
      this.logger.warn(`Mensaje ${mensajeId} — ${resultado.estado}: ${resultado.motivo}`);
    }

    const { count } = await this.prisma.mensaje.updateMany({
      /*
       * El `where` excluye los ticks que ya avanzaron. Un `statuses` puede
       * habernos ganado la carrera —Meta contesta el webhook mientras nuestra
       * respuesta HTTP todavía viaja— y sobrescribir ENTREGADO/LEIDO con
       * ENVIADO haría RETROCEDER el tick en pantalla, que es justo lo que
       * `procesarEstadoMensaje` lleva evitando desde siempre.
       */
      where: { id: mensajeId, estadoEnvio: { notIn: ['ENTREGADO', 'LEIDO'] } },
      data: datosSegunResultado(resultado, agendable && !reintento),
    });

    if (count === 0) {
      /* `debug` y no `warn`: en producción es rarísimo, pero en la suite pasa
         once veces por corrida y un warn que sale siempre enseña a ignorarlos.
         Cubre dos casos benignos: la conversación borrada mientras Meta
         contestaba, y el tick que ya iba por delante. */
      this.logger.debug(`El mensaje ${mensajeId} ya no existe al anotar el resultado del envío.`);
    }

    this.gateway.emitirActividad(conversacionId);
  }
}

/**
 * Decide cómo mandar un texto del agente.
 *
 * Si pega una URL de imagen o de PDF, WhatsApp lo enseña como adjunto en vez de
 * como un enlace azul — que es lo que el agente espera al pegar el link de un
 * estudio. Cualquier otra cosa va como texto.
 */
export function contenidoSegunTexto(contenido: string): ContenidoMensaje {
  const limpio = contenido.trim();
  const esUrl = limpio.startsWith('http://') || limpio.startsWith('https://');

  if (esUrl && /\.(png|jpe?g|webp|gif)(\?.*)?$/i.test(limpio)) {
    return { type: 'image', image: { link: limpio } };
  }
  if (esUrl && /\.pdf(\?.*)?$/i.test(limpio)) {
    return { type: 'document', document: { link: limpio, filename: 'Documento.pdf' } };
  }
  return { type: 'text', text: { body: contenido } };
}

/**
 * Cuánto se espera antes de volver a intentar un envío que **consta** que no
 * salió, y cuándo se deja de intentar.
 *
 * Tres intentos y se acaba. El tope no es prudencia decorativa: pasada la
 * ventana de servicio al cliente de 24 h, Meta rechaza el texto libre de todas
 * formas, así que insistir más allá solo gasta cuota y llena el journal. Y el
 * reparto 1 / 5 / 25 min cubre lo que de verdad se recupera solo —un despliegue,
 * un corte de red, un 5xx pasajero de Meta— sin convertirse en una cola que
 * despierta al proceso cada minuto.
 *
 * Devuelve `null` cuando ya no hay que reintentar: el barrido lo lee como
 * "ríndete" y limpia `proximoIntento` para que la fila deje de aparecer.
 *
 * @param intentos Cuántos van hechos ya, contando el que acaba de fallar.
 */
export function proximoReintento(intentos: number, desde = new Date()): Date | null {
  const ESPERAS_MS = [60_000, 5 * 60_000, 25 * 60_000];
  const espera = ESPERAS_MS[intentos - 1];
  return espera === undefined ? null : new Date(desde.getTime() + espera);
}

/**
 * Traduce el desenlace del envío a lo que se escribe en la fila.
 *
 * Está fuera de la clase para que se pueda leer de un vistazo lo único que
 * importa aquí: **qué significa cada estado para la paciente.**
 *
 * - `ENVIADO` — salió. Se guarda el id de Meta para correlacionar el `statuses`
 *   y se levanta el tick, que pudo quedar en FALLIDO si esto es un reintento.
 * - `NO_SALIO` — consta que no llegó nada. FALLIDO y se agenda el reintento.
 * - `INCIERTO` — **no se sabe**. Se anota como tal y NO se agenda nada:
 *   reenviarlo por nuestra cuenta es lo que le duplicaría el mensaje a la
 *   paciente. Si salió, el `statuses` con `biz_opaque_callback_data` lo dirá; si
 *   no llega nunca, queda visible para que lo decida una persona.
 */
export function datosSegunResultado(
  resultado: ResultadoEnvio,
  agendar = true,
): Prisma.MensajeUpdateManyMutationInput {
  switch (resultado.estado) {
    case 'ENVIADO':
      return { whatsappMsgId: resultado.metaMsgId, estadoEnvio: 'ENVIADO', proximoIntento: null };
    case 'NO_SALIO':
      /* `agendar` es false en dos casos, por motivos distintos: en un reintento
         porque el barrido ya agendó el siguiente turno, y en una plantilla
         porque no se puede reconstruir (la fila guarda el texto ya compuesto,
         no el nombre ni los parámetros). Reenviarla como texto plano fuera de
         la ventana de 24 h la rebotaría igual. */
      return { estadoEnvio: 'FALLIDO', ...(agendar ? { proximoIntento: proximoReintento(1) } : {}) };
    case 'INCIERTO':
      return { estadoEnvio: 'INCIERTO', proximoIntento: null };
  }
}
