import { imageSize } from 'image-size';

export interface Dimensiones {
  readonly ancho: number;
  readonly alto: number;
}

/**
 * Ancho y alto de una imagen tal como la VE el navegador, leídos de la
 * cabecera del archivo (sin decodificarla).
 *
 * Existen para que el chat reserve la caja exacta de cada foto antes de que
 * llegue: sin ellas la burbuja nacía con altura 0 y crecía al cargar, y en un
 * chat con muchas fotos el hilo se reacomodaba una vez por imagen —el
 * parpadeo al abrirlo—.
 *
 * Las fotos de teléfono suelen venir giradas por EXIF (orientación 5–8): el
 * archivo guarda 4000×3000 pero el navegador la muestra de 3000×4000. Se
 * devuelven ya intercambiadas, que es lo que importa para la caja.
 *
 * `null` si no es una imagen o la cabecera no se entiende: la vista usa
 * entonces una caja fija, que también evita el salto.
 */
export function dimensionesImagen(bytes: ArrayBuffer | Uint8Array, mime: string | null | undefined): Dimensiones | null {
  if (!mime?.toLowerCase().startsWith('image/')) return null;
  try {
    const leido = imageSize(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    if (!leido.width || !leido.height) return null;
    const girada = leido.orientation !== undefined && leido.orientation >= 5 && leido.orientation <= 8;
    return girada ? { ancho: leido.height, alto: leido.width } : { ancho: leido.width, alto: leido.height };
  } catch {
    return null;
  }
}
