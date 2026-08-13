import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AwsClient } from 'aws4fetch';

/**
 * Almacenamiento de archivos en Cloudflare R2 (S3-compatible).
 *
 * Se usa para la media entrante de WhatsApp (fotos, documentos, audio): los
 * archivos NO se guardan en el disco del VPS —que es chico y compartido— sino
 * en R2, y se sirven al frontend con URLs firmadas de corta duración (rápidas
 * por CDN y privadas: si el enlace se filtra, expira en minutos).
 *
 * Firma las peticiones S3 con `aws4fetch` (~5 KB, sin dependencias) en vez del
 * SDK de AWS: R2 no tiene SDK propio, solo necesita SigV4 sobre `fetch`, y el
 * SDK completo era demasiado pesado para instalar/correr en este VPS.
 *
 * Si las variables R2_* no están configuradas, el servicio queda deshabilitado
 * y el manejo de media simplemente no ocurre (el resto del CRM sigue igual).
 */
@Injectable()
export class R2Service {
  private readonly logger = new Logger(R2Service.name);
  private readonly client: AwsClient | null;
  /** `https://<account>.r2.cloudflarestorage.com/<bucket>` */
  private readonly baseUrl: string = '';

  constructor(config: ConfigService) {
    const account = config.get<string>('R2_ACCOUNT_ID');
    const accessKeyId = config.get<string>('R2_ACCESS_KEY_ID');
    const secretAccessKey = config.get<string>('R2_SECRET_ACCESS_KEY');
    const bucket = config.get<string>('R2_BUCKET') ?? '';

    if (account && accessKeyId && secretAccessKey && bucket) {
      this.client = new AwsClient({ accessKeyId, secretAccessKey, region: 'auto', service: 's3' });
      this.baseUrl = `https://${account}.r2.cloudflarestorage.com/${bucket}`;
    } else {
      this.client = null;
      this.logger.warn('R2 no configurado (faltan R2_*); el manejo de media queda deshabilitado.');
    }
  }

  get habilitado(): boolean {
    return this.client !== null;
  }

  async subir(key: string, cuerpo: ArrayBuffer, mime: string): Promise<void> {
    if (!this.client) return;
    /* Blob (que lleva su propio Content-Type) en vez de pasar el buffer directo:
       el tipo `BodyInit` de fetch no acepta Uint8Array de forma estable. */
    const resp = await this.client.fetch(`${this.baseUrl}/${key}`, {
      method: 'PUT',
      body: new Blob([cuerpo], { type: mime }),
    });
    if (!resp.ok) {
      throw new Error(`R2 PUT ${resp.status}: ${await resp.text()}`);
    }
  }

  /**
   * URL de descarga firmada, válida `ttlSegundos` (por defecto 1 hora).
   *
   * Estaba en 15 minutos y era demasiado corto para algo que se queda pintado
   * en pantalla: al bloquear el teléfono, el navegador congela los temporizadores
   * de la pestaña, así que el refresco de 60 s del inbox no corre. Al volver, las
   * `<img>` ya renderizadas llevaban URLs caducadas y salía el icono de imagen
   * rota — sin que faltara ni un archivo en R2, comprobado uno por uno.
   *
   * Una hora reduce mucho esa ventana sin regalar gran cosa: la URL solo existe
   * dentro del navegador de la agente autenticada, y quien la copie tendrá una
   * foto de paciente accesible durante ese rato. Por eso no se sube más.
   */
  async urlFirmada(key: string, ttlSegundos = 3600): Promise<string | null> {
    if (!this.client) return null;
    try {
      const signed = await this.client.sign(`${this.baseUrl}/${key}?X-Amz-Expires=${ttlSegundos}`, {
        method: 'GET',
        aws: { signQuery: true },
      });
      return signed.url;
    } catch (error) {
      this.logger.error(`No se pudo firmar URL para ${key}`, error);
      return null;
    }
  }

  async eliminar(key: string): Promise<void> {
    if (!this.client) return;
    await this.client.fetch(`${this.baseUrl}/${key}`, { method: 'DELETE' });
  }

  /**
   * Descarga los bytes del archivo directamente desde R2 (servidor a servidor).
   *
   * Lo usa el endpoint proxy de descarga: el navegador no puede hacer `fetch`
   * a las URLs firmadas de R2 por CORS, así que el backend baja los bytes con
   * sus credenciales y los reenvía con `Content-Disposition: attachment`.
   */
  async descargar(key: string): Promise<{ buffer: ArrayBuffer; contentType: string } | null> {
    if (!this.client) return null;
    try {
      const resp = await this.client.fetch(`${this.baseUrl}/${key}`, { method: 'GET' });
      if (!resp.ok) {
        this.logger.error(`R2 GET ${resp.status} para key=${key}`);
        return null;
      }
      const buffer = await resp.arrayBuffer();
      const contentType = resp.headers.get('content-type') ?? 'application/octet-stream';
      return { buffer, contentType };
    } catch (error) {
      this.logger.error(`No se pudo descargar ${key} de R2`, error);
      return null;
    }
  }
}
