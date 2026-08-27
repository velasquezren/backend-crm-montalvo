import { Injectable, Logger } from '@nestjs/common';

import { R2Service } from '../../common/storage/r2.service';
import { ContenidoMensaje, WhatsappCloudService } from '../../common/whatsapp/whatsapp-cloud.service';
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
 * la ve en pantalla. Por eso todos los caminos terminan igual —en
 * `registrarResultadoEnvio`— y ninguno lanza: un fallo de Meta marca el tick en
 * FALLIDO, no tumba la petición que ya devolvió 200.
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
      await this.registrarResultadoEnvio(destino, null);
      return;
    }

    await this.registrarResultadoEnvio(destino, await this.whatsapp.enviar(destino.telefono, contenidoMeta));
  }

  /** Acuse con botonera de respuesta rápida. Degrada a texto plano si Meta lo rechaza. */
  async botones(destino: Destino, texto: string, botones: string[]): Promise<void> {
    const metaMsgId = await this.whatsapp.enviar(destino.telefono, {
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
    });

    if (metaMsgId) {
      await this.registrarResultadoEnvio(destino, metaMsgId);
      return;
    }

    /* Meta rechaza un interactivo malformado ENTERO. Antes de dejar al paciente
       sin nada, se reintenta como texto plano: un acuse feo es mejor que ninguno. */
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

    const metaMsgId = await this.whatsapp.enviar(destino.telefono, {
      type: 'template',
      template: {
        name: dto.plantilla,
        language: { code: dto.idioma },
        ...(componentes ? { components: componentes } : {}),
      },
    });

    await this.registrarResultadoEnvio(destino, metaMsgId);
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
   * Anota en el mensaje lo que contestó Meta.
   *
   * Lo comparten los tres caminos de envío (texto, plantilla y botones): sin el
   * id no hubo entrega, así que el tick pasa a FALLIDO; con id se guarda para
   * que el webhook de `statuses` pueda correlacionar entregado/leído de vuelta.
   * En ambos casos se avisa por WebSocket, para que el tick cambie en pantalla
   * sin que el agente recargue.
   */
  private async registrarResultadoEnvio(
    { mensajeId, conversacionId }: Destino,
    metaMsgId: string | null,
  ): Promise<void> {
    /*
     * `updateMany` y no `update` porque esto corre en un `void` sin `.catch()`
     * (ver `enviarMensaje`): `update` LANZA si la fila ya no está, y una
     * promesa rechazada sin manejar no la ve nadie hasta que tumba el proceso.
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
    const { count } = await this.prisma.mensaje.updateMany({
      where: { id: mensajeId },
      data: metaMsgId ? { whatsappMsgId: metaMsgId } : { estadoEnvio: 'FALLIDO' },
    });

    if (count === 0) {
      /* `debug` y no `warn`: en producción es rarísimo, pero en la suite pasa
         once veces por corrida y un warn que sale siempre enseña a ignorarlos. */
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
