import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Referencia de una reserva para el paso de pago. ScriptCase pasa el id a la
 * vista en claro (`P_AGE`): con eso cualquiera podría cargar un comprobante en
 * la reserva de otra persona. Aquí el id va firmado y caduca.
 *
 *   «<para_age>.<vence, segundos>.<firma>»
 */
const VIGENCIA_SEGUNDOS = 6 * 60 * 60;

function firma(secreto: string, contenido: string): string {
  return createHmac('sha256', secreto).update(contenido).digest('base64url');
}

export function firmarReferencia(paraAge: number, secreto: string, ahora = Date.now()): string {
  const vence = Math.floor(ahora / 1000) + VIGENCIA_SEGUNDOS;
  const contenido = `${paraAge}.${vence}`;
  return `${contenido}.${firma(secreto, contenido)}`;
}

/** El id si la referencia es auténtica y vigente; si no, `null`. */
export function leerReferencia(referencia: string, secreto: string, ahora = Date.now()): number | null {
  const partes = referencia.split('.');
  if (partes.length !== 3 || !/^\d{1,10}$/.test(partes[0]) || !/^\d{1,12}$/.test(partes[1])) return null;
  const esperada = Buffer.from(firma(secreto, `${partes[0]}.${partes[1]}`));
  const recibida = Buffer.from(partes[2]);
  if (esperada.length !== recibida.length || !timingSafeEqual(esperada, recibida)) return null;
  if (Number(partes[1]) * 1000 < ahora) return null;
  const paraAge = Number(partes[0]);
  return Number.isSafeInteger(paraAge) && paraAge > 0 ? paraAge : null;
}
