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
}

const PREFIJO = 'f1';
const VIGENCIA_MS = 24 * 60 * 60 * 1000;

function subclave(): Buffer {
  const base = Buffer.from(process.env['WHATSAPP_INTERACCIONES_KEY'] ?? '', 'base64');
  if (base.length !== 32) throw new Error('Falta WHATSAPP_INTERACCIONES_KEY');
  // Subclave propia: un token de Flow nunca sirve para abrir un sobre de interacción, ni al revés.
  return createHash('sha256').update(Buffer.concat([base, Buffer.from('montalvo:flow-token:v1')])).digest();
}

export function sellarTokenFlow(telefono: string, ahora = Date.now()): string {
  if (!/^\d{8,15}$/.test(telefono)) throw new Error('Teléfono inválido para el token');
  const vector = randomBytes(12);
  const cifrador = createCipheriv('aes-256-gcm', subclave(), vector);
  cifrador.setAAD(Buffer.from(PREFIJO));
  const datos: DatosTokenFlow = { telefono, vence: ahora + VIGENCIA_MS };
  const cuerpo = Buffer.concat([cifrador.update(JSON.stringify(datos), 'utf8'), cifrador.final()]);
  return [PREFIJO, vector.toString('base64url'), cifrador.getAuthTag().toString('base64url'), cuerpo.toString('base64url')].join('.');
}

/** Los datos del token, o `null` si es ajeno, fue alterado o venció. Nunca lanza. */
export function abrirTokenFlow(token: unknown, ahora = Date.now()): DatosTokenFlow | null {
  try {
    if (typeof token !== 'string' || token.length > 256) return null;
    const [prefijo, vector, tag, cuerpo] = token.split('.');
    if (prefijo !== PREFIJO || !vector || !tag || !cuerpo) return null;
    const descifrador = createDecipheriv('aes-256-gcm', subclave(), Buffer.from(vector, 'base64url'));
    descifrador.setAAD(Buffer.from(PREFIJO));
    descifrador.setAuthTag(Buffer.from(tag, 'base64url'));
    const datos = JSON.parse(Buffer.concat([descifrador.update(Buffer.from(cuerpo, 'base64url')), descifrador.final()]).toString('utf8')) as Partial<DatosTokenFlow>;
    if (typeof datos.telefono !== 'string' || !/^\d{8,15}$/.test(datos.telefono) || typeof datos.vence !== 'number' || datos.vence < ahora) return null;
    return { telefono: datos.telefono, vence: datos.vence };
  } catch {
    return null;
  }
}
