import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * El `flow_token` de un Flow con endpoint: lo único que identifica a la
 * paciente en cada pantalla (Meta no manda su teléfono). Va SELLADO
 * (AES-256-GCM con una subclave de `WHATSAPP_INTERACCIONES_KEY`): Meta lo
 * transporta, pero no lo puede leer ni nadie lo puede fabricar, y vence.
 *
 * Cabe en los 256 caracteres que el CRM acepta de un `flow_token`.
 */

export interface DatosTokenFlow {
  /** E.164 sin «+»: el teléfono del chat en que se envió el Flow. */
  telefono: string;
  /** Milisegundos epoch. */
  vence: number;
  lineaId?: string;
}

const PREFIJO = 'f1';
const VIGENCIA_MS = 24 * 60 * 60 * 1000;

function subclave(uso = 'montalvo:flow-token:v1'): Buffer {
  const base = Buffer.from(process.env['WHATSAPP_INTERACCIONES_KEY'] ?? '', 'base64');
  if (base.length !== 32) throw new Error('Falta WHATSAPP_INTERACCIONES_KEY');
  // Subclave propia por uso: un token de Flow nunca sirve para abrir un sobre de interacción, ni al revés.
  return createHash('sha256').update(Buffer.concat([base, Buffer.from(uso)])).digest();
}

function sellar(prefijo: string, clave: Buffer, datos: unknown): string {
  const vector = randomBytes(12);
  const cifrador = createCipheriv('aes-256-gcm', clave, vector);
  cifrador.setAAD(Buffer.from(prefijo));
  const cuerpo = Buffer.concat([cifrador.update(JSON.stringify(datos), 'utf8'), cifrador.final()]);
  return [prefijo, vector.toString('base64url'), cifrador.getAuthTag().toString('base64url'), cuerpo.toString('base64url')].join('.');
}

/** Lanza si el sello es ajeno o fue alterado: quien llama lo convierte en `null`. */
function abrir(prefijo: string, clave: Buffer, sello: string): unknown {
  const [p, vector, tag, cuerpo] = sello.split('.');
  if (sello.split('.').length !== 4 || p !== prefijo || !vector || !tag || !cuerpo) throw new Error('Sello ajeno');
  const descifrador = createDecipheriv('aes-256-gcm', clave, Buffer.from(vector, 'base64url'));
  descifrador.setAAD(Buffer.from(prefijo));
  descifrador.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(Buffer.concat([descifrador.update(Buffer.from(cuerpo, 'base64url')), descifrador.final()]).toString('utf8'));
}

export function sellarTokenFlow(telefono: string, ahora = Date.now(), lineaId?: string): string {
  if (!/^\d{8,15}$/.test(telefono)) throw new Error('Teléfono inválido para el token');
  if (lineaId !== undefined && !/^[a-zA-Z0-9_-]{1,64}$/.test(lineaId)) throw new Error("Línea inválida");
  const datos: DatosTokenFlow = { telefono, vence: ahora + VIGENCIA_MS, ...(lineaId ? { lineaId } : {}) };
  return sellar(PREFIJO, subclave(), datos);
}

/** Los datos del token, o `null` si es ajeno, fue alterado o venció. Nunca lanza. */
export function abrirTokenFlow(token: unknown, ahora = Date.now()): DatosTokenFlow | null {
  try {
    if (typeof token !== 'string' || token.length > 256) return null;
    const datos = abrir(PREFIJO, subclave(), token) as Partial<DatosTokenFlow>;
    if (typeof datos.telefono !== 'string' || !/^\d{8,15}$/.test(datos.telefono) || typeof datos.vence !== 'number' || !Number.isSafeInteger(datos.vence) || datos.vence <= ahora) return null;
    if (datos.lineaId !== undefined && (typeof datos.lineaId !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(datos.lineaId))) return null;
    return { telefono: datos.telefono, vence: datos.vence, ...(datos.lineaId ? { lineaId: datos.lineaId } : {}) };
  } catch {
    return null;
  }
}

/**
 * Lo que el endpoint del Flow de reserva devuelve al cerrarse, sellado. Viaja en
 * la respuesta del Flow (`extension_message_response`) por el teléfono de la
 * paciente hasta el webhook; el sello hace que el chat crea el número de reserva,
 * el monto y el QR sin tener que preguntarle a la agenda: nadie puede pegar su
 * comprobante en la reserva de otra persona cambiando un número.
 */
export interface CierreReserva {
  /** E.164 sin «+»: el teléfono del chat (el del `flow_token`). */
  telefono: string;
  /** `para_agendar.para_age`. */
  reserva: number;
  /** Lo que se le pide pagar, o `null` si el médico no cobra por adelantado aquí. */
  montoCentavos: number | null;
  /** La imagen del QR del médico en R2, o `null`. */
  qrClave: string | null;
}

const PREFIJO_CIERRE = 'c1';
const USO_CIERRE = 'montalvo:flow-cierre-reserva:v1';
/** Las claves que escribe `AgendaReservasService.prepararQr`: nada más se manda como QR. */
export const CLAVE_QR_AGENDA = /^agenda\/qr\/\d{1,10}-[0-9a-f]{16}\.(png|jpg|webp)$/;

export function sellarCierreReserva(cierre: CierreReserva, flowToken: string): string {
  const token = abrirTokenFlow(flowToken);
  if (!token || token.telefono !== cierre.telefono) throw new Error("Cierre sin Flow vigente");
  return sellar(PREFIJO_CIERRE, subclave(USO_CIERRE), { ...cierre, flowHash: createHash("sha256").update(flowToken).digest("hex"), vence: token.vence });
}

/** El cierre, si es nuestro, intacto y bien formado; si no, `null`. Nunca lanza. */
export function abrirCierreReserva(sello: unknown, flowToken: string, ahora = Date.now()): CierreReserva | null {
  try {
    if (typeof sello !== 'string' || sello.length > 500) return null;
    const d = abrir(PREFIJO_CIERRE, subclave(USO_CIERRE), sello) as Partial<CierreReserva> & { flowHash?: unknown; vence?: unknown };
    if (typeof d.vence !== 'number' || !Number.isSafeInteger(d.vence) || d.vence <= ahora
      || d.flowHash !== createHash('sha256').update(flowToken).digest('hex')) return null;
    const monto = d.montoCentavos;
    const qr = d.qrClave;
    if (typeof d.telefono !== 'string' || !/^\d{8,15}$/.test(d.telefono)) return null;
    if (typeof d.reserva !== 'number' || !Number.isSafeInteger(d.reserva) || d.reserva <= 0 || d.reserva > 2147483647) return null;
    if (monto !== null && (typeof monto !== 'number' || !Number.isSafeInteger(monto) || monto <= 0 || monto > 100_000_000)) return null;
    if (qr !== null && (typeof qr !== 'string' || !CLAVE_QR_AGENDA.test(qr))) return null;
    if ((monto === null) !== (qr === null)) return null;
    return { telefono: d.telefono, reserva: d.reserva, montoCentavos: monto ?? null, qrClave: qr ?? null };
  } catch {
    return null;
  }
}
