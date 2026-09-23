import { parsePhoneNumberFromString } from 'libphonenumber-js';

/**
 * Un teléfono en la forma en que lo guarda el CRM: E.164, `+` y dígitos.
 *
 * Es la clave con la que el webhook de WhatsApp encuentra a la paciente
 * (`+` + `wa_id`). Un número escrito a mano con espacios o guiones —que
 * `@IsPhoneNumber()` acepta— se guardaba tal cual, y cuando la paciente
 * contestaba el webhook no lo reconocía: nacía una segunda ficha y un segundo
 * chat, y la respuesta no llegaba a la conversación que se había iniciado.
 *
 * Sin prefijo se asume Bolivia (`70012345` → `+59170012345`). Devuelve `null`
 * si no es un teléfono.
 */
export function normalizarTelefono(valor: string | null | undefined): string | null {
  if (!valor?.trim()) return null;
  const numero = parsePhoneNumberFromString(valor.trim(), 'BO');
  if (numero?.isValid()) return numero.number;

  /* Numeraciones que la librería aún no reconoce pero que WhatsApp sí manda
     (el `+521…` de los móviles de México, por ejemplo): con país explícito se
     respetan los dígitos antes que rechazar a la paciente. */
  const digitos = valor.replace(/\D/g, '');
  return valor.trim().startsWith('+') && /^\d{8,15}$/.test(digitos) ? `+${digitos}` : null;
}
