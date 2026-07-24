import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Almacenamiento de archivos en Cloudflare R2 (S3-compatible).
 *
 * Se usa para la media entrante de WhatsApp (fotos, documentos, audio): los
 * archivos NO se guardan en el disco del VPS —que es chico y compartido— sino
 * en R2, y se sirven al frontend con URLs firmadas de corta duración (rápidas
 * por CDN y privadas: si el enlace se filtra, expira en minutos).
 *
 * Si las variables R2_* no están configuradas, el servicio queda deshabilitado
 * y el manejo de media simplemente no ocurre (el resto del CRM sigue igual).
 */
@Injectable()
export class R2Service {
  private readonly logger = new Logger(R2Service.name);
  private readonly client: S3Client | null;
  private readonly bucket: string;

  constructor(config: ConfigService) {
    const account = config.get<string>('R2_ACCOUNT_ID');
    const accessKeyId = config.get<string>('R2_ACCESS_KEY_ID');
    const secretAccessKey = config.get<string>('R2_SECRET_ACCESS_KEY');
    this.bucket = config.get<string>('R2_BUCKET') ?? '';

    if (account && accessKeyId && secretAccessKey && this.bucket) {
      this.client = new S3Client({
        region: 'auto',
        endpoint: `https://${account}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId, secretAccessKey },
      });
    } else {
      this.client = null;
      this.logger.warn('R2 no configurado (faltan R2_*); el manejo de media queda deshabilitado.');
    }
  }

  get habilitado(): boolean {
    return this.client !== null;
  }

  async subir(key: string, cuerpo: Buffer | Uint8Array, mime: string): Promise<void> {
    if (!this.client) return;
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: cuerpo, ContentType: mime }),
    );
  }

  /** URL de descarga firmada, válida `ttlSegundos` (default 15 min). */
  async urlFirmada(key: string, ttlSegundos = 900): Promise<string | null> {
    if (!this.client) return null;
    try {
      return await getSignedUrl(
        this.client,
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { expiresIn: ttlSegundos },
      );
    } catch (error) {
      this.logger.error(`No se pudo firmar URL para ${key}`, error);
      return null;
    }
  }

  async eliminar(key: string): Promise<void> {
    if (!this.client) return;
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
