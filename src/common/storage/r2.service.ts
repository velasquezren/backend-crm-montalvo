import { ErrorMedia, errorHttpMedia, sanitizarErrorMedia } from '../fiabilidad/error-media';
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
/**
 * Cabecera que R2 guarda con cada archivo y devuelve al leerlo. Toda clave es
 * única y su contenido no cambia (un adjunto por mensaje, un recurso por
 * subida), así que el navegador puede quedárselo sin volver a preguntar.
 * Probado contra R2: la URL firmada NO puede fijarla (`response-cache-control`
 * responde 501); tiene que ir como metadato al subir.
 */
const CACHE_INMUTABLE = 'private, max-age=31536000, immutable';

/** Cuánto dura una misma URL firmada. Ver `urlFirmada`. */
const VENTANA_FIRMA_MS = 60 * 60 * 1000;

/** `20260923T190000Z`: el formato de fecha de la firma AWS v4. */
function fechaAmz(ms: number): string {
  return new Date(ms).toISOString().replace(/[:-]|\.\d{3}/g, '');
}

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
      headers: { 'Cache-Control': CACHE_INMUTABLE },
    });
    if (!resp.ok) {
      throw new Error(`R2 PUT ${resp.status}: ${await resp.text()}`);
    }
  }

  /**
   * Un PUT por intento de recepción, sin el retry interno de AwsClient.fetch.
   * La cancelación abarca firma y transporte; la clave es determinista.
   * Los otros consumidores conservan subir() y su contrato actual.
   */
  async subirMediaEntrante(key: string, cuerpo: ArrayBuffer, mime: string, signal: AbortSignal): Promise<void> {
    if (!this.client) throw new ErrorMedia('R2_SIN_CONFIGURAR', 'CONFIGURACION');
    try {
      signal.throwIfAborted();
      const peticion = await this.client.sign(`${this.baseUrl}/${key}`, {
        method: 'PUT', body: new Blob([cuerpo], { type: mime }), signal,
        headers: { 'If-None-Match': '*', 'Cache-Control': CACHE_INMUTABLE },
      });
      signal.throwIfAborted();
      const respuesta = await fetch(peticion, { signal });
      await respuesta.body?.cancel();
      // El objeto de un Mensaje es inmutable: 412 confirma que ya existe.
      if (!respuesta.ok && respuesta.status !== 412) throw errorHttpMedia('R2', respuesta.status);
    } catch (error) {
      throw sanitizarErrorMedia(error);
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
  /**
   * URL de lectura firmada, **la misma para una clave durante toda una hora**.
   *
   * Se firmaba con la hora exacta de cada petición, así que cada vez que se
   * abría o se recargaba un chat —también con cada mensaje en tiempo real—
   * todas sus imágenes tenían una URL distinta: para el navegador eran otros
   * archivos, no usaba su caché y las volvía a descargar. En un chat con muchas
   * fotos, eso era el parpadeo al entrar.
   *
   * Ahora la firma se fecha al inicio de la hora en curso y caduca una hora
   * después de que esa hora termine: dentro de la ventana la URL es idéntica
   * (caché del navegador), y quien la recibe sigue teniendo al menos
   * `ttlSegundos` de validez, como antes.
   */
  async urlFirmada(key: string, ttlSegundos = 3600, ahora = Date.now()): Promise<string | null> {
    if (!this.client) return null;
    try {
      const inicio = Math.floor(ahora / VENTANA_FIRMA_MS) * VENTANA_FIRMA_MS;
      const caduca = VENTANA_FIRMA_MS / 1000 + ttlSegundos;
      const signed = await this.client.sign(`${this.baseUrl}/${key}?X-Amz-Expires=${caduca}`, {
        method: 'GET',
        aws: { signQuery: true, datetime: fechaAmz(inicio) },
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
}
