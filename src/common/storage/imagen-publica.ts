import { imageSize } from 'image-size';

/**
 * Validación de las imágenes que se publican (banners de promociones, fotos del
 * directorio médico). Se las sirve a cualquiera —la landing, Meta—, así que no
 * se confía en el `mimetype` que declara el navegador: el tipo sale de los bytes.
 */

/** Los únicos formatos que se aceptan: los que muestran todos los navegadores y Meta. */
const TIPOS = {
  jpg: { mime: 'image/jpeg', extension: 'jpg' },
  png: { mime: 'image/png', extension: 'png' },
  webp: { mime: 'image/webp', extension: 'webp' },
} as const;

/** 5 MB: el tope de Meta para una imagen de WhatsApp y de sobra para un banner. */
export const BYTES_MAXIMOS_IMAGEN = 5 * 1024 * 1024;

export interface ImagenPublica {
  readonly mime: string;
  readonly extension: string;
  /** Como la VE el navegador: una foto girada por EXIF devuelve sus medidas ya giradas. */
  readonly ancho: number;
  readonly alto: number;
  readonly bytes: number;
}

/** La imagen validada, o el motivo legible por el que se rechaza. */
export function validarImagenPublica(contenido: Uint8Array): ImagenPublica | { error: string } {
  if (contenido.byteLength === 0) return { error: 'El archivo está vacío.' };
  if (contenido.byteLength > BYTES_MAXIMOS_IMAGEN) return { error: 'La imagen pesa más de 5 MB.' };
  let leido: ReturnType<typeof imageSize>;
  try {
    leido = imageSize(contenido);
  } catch {
    return { error: 'No es una imagen JPG, PNG o WebP válida.' };
  }
  const tipo = leido.type && leido.type in TIPOS ? TIPOS[leido.type as keyof typeof TIPOS] : null;
  if (!tipo || !leido.width || !leido.height) return { error: 'Solo se aceptan imágenes JPG, PNG o WebP.' };
  const girada = leido.orientation !== undefined && leido.orientation >= 5 && leido.orientation <= 8;
  return {
    mime: tipo.mime,
    extension: tipo.extension,
    ancho: girada ? leido.height : leido.width,
    alto: girada ? leido.width : leido.height,
    bytes: contenido.byteLength,
  };
}

/**
 * La URL con que se publica una ruta de esta API. Con `CRM_URL_PUBLICA` es
 * absoluta (la que necesitan la landing y Meta); sin ella, la ruta tal cual, que
 * es lo que cada consumidor completa con su propia base.
 */
export function urlPublica(ruta: string): string {
  const base = process.env['CRM_URL_PUBLICA']?.trim().replace(/\/+$/, '');
  return base ? `${base}${ruta}` : ruta;
}

/**
 * Cabeceras de una imagen pública. Su URL lleva un id que cambia con cada imagen
 * nueva, así que el contenido de una URL no cambia nunca: se puede guardar para
 * siempre. `cross-origin`, porque la muestra otro dominio (landing, CRM en Vercel):
 * el `same-origin` de Helmet la bloquearía (ver `CabecerasPlantillaController`).
 */
export const CABECERAS_IMAGEN_PUBLICA = {
  'Cache-Control': 'public, max-age=31536000, immutable',
  'Cross-Origin-Resource-Policy': 'cross-origin',
} as const;
