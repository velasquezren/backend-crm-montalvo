import { constants, createCipheriv, createDecipheriv, KeyObject, privateDecrypt } from 'node:crypto';

/**
 * El cifrado del endpoint de WhatsApp Flows (data_api_version 3.0), tal como lo
 * define Meta: cada petición trae una clave AES-128 nueva, cifrada con la llave
 * PÚBLICA de la empresa (RSA-OAEP, SHA-256); con ella van los datos en
 * AES-128-GCM. La respuesta se cifra con la MISMA clave y el vector invertido
 * bit a bit, y viaja en base64 como texto plano.
 *
 * La llave privada nunca sale del servidor del CRM (ver
 * `scripts/whatsapp/flow-llaves.sh`); este archivo no sabe de dónde viene.
 */

export interface PeticionCifrada {
  encrypted_flow_data: string;
  encrypted_aes_key: string;
  initial_vector: string;
}

export interface PeticionDescifrada {
  datos: unknown;
  /** Para cifrar la respuesta: la clave y el vector de ESTA petición. */
  clave: Buffer;
  vector: Buffer;
}

/** Meta no pudo descifrar / nosotros no pudimos: el protocolo pide 421 para que el cliente refresque la llave. */
export class ErrorDeCifradoFlow extends Error {}

const TAG = 16;

export function esPeticionCifrada(v: unknown): v is PeticionCifrada {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return ['encrypted_flow_data', 'encrypted_aes_key', 'initial_vector'].every(k => typeof o[k] === 'string' && (o[k] as string).length > 0 && (o[k] as string).length < 1_000_000);
}

export function descifrarPeticionFlow(peticion: PeticionCifrada, llavePrivada: KeyObject): PeticionDescifrada {
  try {
    const clave = privateDecrypt(
      { key: llavePrivada, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(peticion.encrypted_aes_key, 'base64'),
    );
    if (clave.length !== 16) throw new Error('Clave AES inesperada');
    const vector = Buffer.from(peticion.initial_vector, 'base64');
    const cuerpo = Buffer.from(peticion.encrypted_flow_data, 'base64');
    if (cuerpo.length <= TAG) throw new Error('Datos cifrados vacíos');
    const descifrador = createDecipheriv('aes-128-gcm', clave, vector);
    descifrador.setAuthTag(cuerpo.subarray(cuerpo.length - TAG));
    const claro = Buffer.concat([descifrador.update(cuerpo.subarray(0, cuerpo.length - TAG)), descifrador.final()]);
    return { datos: JSON.parse(claro.toString('utf8')) as unknown, clave, vector };
  } catch {
    throw new ErrorDeCifradoFlow('No se pudo descifrar la petición del Flow');
  }
}

/** La respuesta, cifrada como la espera Meta: base64(AES-128-GCM(json) + tag), con el vector invertido. */
export function cifrarRespuestaFlow(respuesta: unknown, clave: Buffer, vector: Buffer): string {
  const invertido = Buffer.from(vector.map(b => b ^ 0xff));
  const cifrador = createCipheriv('aes-128-gcm', clave, invertido);
  const cuerpo = Buffer.concat([cifrador.update(JSON.stringify(respuesta), 'utf8'), cifrador.final(), cifrador.getAuthTag()]);
  return cuerpo.toString('base64');
}
