/** Solo códigos propios: nunca cuerpos HTTP, tokens, URLs ni mensajes de terceros. */
export class ErrorMedia extends Error {
  constructor(
    readonly codigo: string,
    readonly categoria: 'TRANSITORIO' | 'CONFIGURACION' | 'PERMANENTE' = 'TRANSITORIO',
  ) {
    super(codigo);
    this.name = 'ErrorMedia';
  }
}

export function errorHttpMedia(
  origen: 'META_ORIGEN' | 'META_DESCARGA' | 'R2',
  status: number,
): ErrorMedia {
  if (status === 401 || status === 403 || (origen === 'R2' && status === 404)) {
    return new ErrorMedia(`${origen}_CONFIGURACION`, 'CONFIGURACION');
  }
  // Un 404 del CDN puede ser la URL temporal caducada: pedir una nueva URL.
  if (origen === 'META_ORIGEN' && (status === 404 || status === 410)) {
    return new ErrorMedia('MEDIA_NO_DISPONIBLE', 'PERMANENTE');
  }
  if (status === 413) return new ErrorMedia('TAMANO_EXCEDIDO', 'PERMANENTE');
  return new ErrorMedia(`${origen}_HTTP_${status}`);
}

export function sanitizarErrorMedia(error: unknown): ErrorMedia {
  if (error instanceof ErrorMedia) return error;
  if (error && typeof error === 'object' && 'name' in error &&
      (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return new ErrorMedia('TIEMPO_AGOTADO');
  }
  return new ErrorMedia('FALLO_TRANSITORIO');
}
