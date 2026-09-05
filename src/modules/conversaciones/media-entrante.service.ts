import { Injectable, Logger } from '@nestjs/common';
import { TipoMensaje } from '../../prisma/prisma-client';

import { R2Service } from '../../common/storage/r2.service';
import { WhatsappCloudService } from '../../common/whatsapp/whatsapp-cloud.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ConversacionesGateway } from './conversaciones.gateway';

/** Media entrante ya normalizada por el webhook (ver extraerMedia). */
export interface MediaEntrante {
  tipo: TipoMensaje;
  mediaId: string;
  mime: string;
  nombre?: string;
}

/**
 * Tope de la media entrante que se baja a memoria. WhatsApp acepta documentos
 * de hasta 100 MB, y `arrayBuffer()` los carga enteros: dos o tres a la vez
 * tumban un VPS de 1,7 GB donde además viven otras dos apps. 25 MB cubre de
 * sobra fotos, audios y PDFs de estudios, que es lo que manda un paciente.
 */
const MAX_BYTES_MEDIA = 25 * 1024 * 1024;

const MB = (bytes: number) => Math.round(bytes / 1024 / 1024);

/**
 * Trae a R2 la foto o el PDF que mandó el paciente.
 *
 * Va **siempre en segundo plano**: el webhook de Meta tiene que contestar en
 * milisegundos o Meta reintenta y acaba desactivando la suscripción, y bajar
 * un PDF de 20 MB no cabe en ese presupuesto. Por eso ningún camino de aquí
 * lanza: si la descarga falla, el mensaje del paciente ya está guardado y lo
 * único que se pierde es el adjunto.
 *
 * Se guarda la **clave** de R2, nunca la URL: `urlFirmada()` caduca a los 15
 * minutos y una URL guardada deja la burbuja rota esa misma tarde.
 */
@Injectable()
export class MediaEntranteService {
  private readonly logger = new Logger(MediaEntranteService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: ConversacionesGateway,
    private readonly r2: R2Service,
    private readonly whatsapp: WhatsappCloudService,
  ) {}

  /** `false` si no hay R2 configurado: sin destino no vale la pena bajar nada. */
  get habilitado(): boolean {
    return this.r2.habilitado;
  }

  /**
   * media_id → URL temporal de Meta → bytes → PUT en R2 con clave
   * `wa/<conversacionId>/<mensajeId>`. Al terminar guarda `mediaKey` y avisa
   * por WebSocket para que la foto aparezca sola en el chat abierto.
   */
  async traer(mensajeId: string, conversacionId: string, media: MediaEntrante): Promise<void> {
    try {
      /* 1) media_id → URL temporal (válida 5 min). */
      const url = await this.whatsapp.urlDeMedia(media.mediaId);
      if (!url) return;

      /* 2) Descargar los bytes (el CDN de Meta también pide el token). */
      const archivo = await this.whatsapp.descargarMedia(url);
      if (!archivo) {
        this.logger.error(`No se pudo descargar media ${media.mediaId}`);
        return;
      }

      const bytes = await this.leerAcotado(archivo, media.mediaId);
      if (!bytes) return;

      /* 3) Subir a R2 y registrar la clave en el mensaje. */
      const key = `wa/${conversacionId}/${mensajeId}`;
      await this.r2.subir(key, bytes, media.mime);
      await this.prisma.mensaje.update({ where: { id: mensajeId }, data: { mediaKey: key } });

      this.gateway.emitirActividad(conversacionId);
    } catch (error) {
      this.logger.error(`Excepción bajando/subiendo media ${media.mediaId}`, error);
    }
  }

  /**
   * Bytes del archivo, o `null` si pasa del tope.
   *
   * El corte real lo hace `content-length`, que Meta siempre manda: descarta
   * antes de reservar un solo byte. La comprobación de después es la red de
   * seguridad por si algún día llega sin cabecera — ahí ya se pagó la memoria,
   * pero al menos no se sube a R2 ni se guarda.
   */
  private async leerAcotado(archivo: Response, mediaId: string): Promise<ArrayBuffer | null> {
    const declarado = Number(archivo.headers.get('content-length'));
    if (Number.isFinite(declarado) && declarado > MAX_BYTES_MEDIA) {
      this.logger.warn(
        `Media ${mediaId} descartada: ${MB(declarado)} MB supera el tope de ${MB(MAX_BYTES_MEDIA)} MB`,
      );
      return null;
    }

    const bytes = await archivo.arrayBuffer();
    if (bytes.byteLength > MAX_BYTES_MEDIA) {
      this.logger.warn(
        `Media ${mediaId} descartada tras descargar: ${MB(bytes.byteLength)} MB supera el tope`,
      );
      return null;
    }
    return bytes;
  }
}
