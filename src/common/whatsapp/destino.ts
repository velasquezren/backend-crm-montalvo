/**
 * A quién se le manda un WhatsApp: su teléfono o, si no lo tenemos, su BSUID.
 *
 * Desde 2026 una persona puede adoptar un nombre de usuario en WhatsApp. Si lo
 * hizo y no hubo trato con ella en los últimos 30 días, Meta **deja de mandar su
 * teléfono** en el webhook (`messages[].from`, `contacts[].wa_id`) y solo manda
 * su BSUID —Business-Scoped User ID—, propio de esta empresa: `BO.1349…`.
 * Se le puede contestar igual: Meta acepta `recipient` con el BSUID en vez de
 * `to` con el número.
 *
 * Por eso el resto del CRM no decide nada de esto: una ficha tiene
 * `telefono`, `waUsuarioId` o ambos, y `destinoWhatsapp` devuelve la dirección
 * a la que se envía —el teléfono si lo hay, porque el número es lo que Meta
 * prefiere y lo que mantiene llegando el teléfono en los webhooks siguientes—.
 * `campoDestino` lo traduce al campo del cuerpo que pide la Cloud API.
 *
 * Las dos formas no se confunden: un teléfono es `+` y dígitos; un BSUID,
 * dos letras de país y un punto. Lo que pide un NÚMERO de verdad —la agenda,
 * el token de un Flow con endpoint, la autoconsulta de informes— lo comprueba
 * con `esBsuid` y no se lo pasa nunca a un BSUID.
 *
 * Contrato de Meta: developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids
 */

/**
 * `<ISO 3166 alfa-2>.<hasta 128 alfanuméricos>`; el BSUID «padre» de un
 * portafolio lleva un segmento más (`US.ENT.1181…`). La columna guarda 160.
 */
const PATRON_BSUID = /^[A-Z]{2}\.(?:[A-Z]{2,8}\.)?[A-Za-z0-9]{1,128}$/;

export function esBsuid(valor: string | null | undefined): boolean {
  return typeof valor === 'string' && PATRON_BSUID.test(valor);
}

/** El BSUID tal como llegó, o `null` si lo que llegó no lo es (Meta exige el valor entero). */
export function normalizarBsuid(valor: string | null | undefined): string | null {
  const limpio = valor?.trim();
  return limpio && esBsuid(limpio) ? limpio : null;
}

/** Lo que el CRM sabe de cómo escribirle a una persona. Al menos uno no es null. */
export interface ContactoWhatsapp {
  readonly telefono: string | null;
  readonly waUsuarioId: string | null;
}

/**
 * Quién escribió, según el webhook. Meta manda el BSUID en todos los mensajes
 * desde abril de 2026 y el teléfono solo si puede; un webhook antiguo, solo el
 * teléfono. `usuario` es el nombre de usuario (`@maria`) si lo tiene.
 */
export interface RemitenteWhatsapp {
  readonly telefono?: string | null;
  readonly waUsuarioId?: string | null;
  readonly usuario?: string | null;
}

/**
 * La dirección a la que se le envía: el teléfono si lo hay, si no el BSUID.
 * Lanza si la ficha no tiene ninguno; la base lo impide con un CHECK, así que
 * llegar aquí es un `select` que olvidó pedir `waUsuarioId`.
 */
export function destinoWhatsapp(contacto: ContactoWhatsapp): string {
  const destino = contacto.telefono ?? contacto.waUsuarioId;
  if (!destino) throw new Error('La ficha no tiene teléfono ni BSUID de WhatsApp');
  return destino;
}

/** El teléfono de la dirección, o `null` si es un BSUID. Para lo que exige un número. */
export function telefonoDeDestino(destino: string): string | null {
  return esBsuid(destino) ? null : destino;
}

/**
 * El campo del cuerpo de `POST /messages`. Meta espera solo dígitos en `to`
 * (el volcado de FileMaker trae números con espacios y guiones) y el BSUID
 * entero, sin tocar, en `recipient`.
 */
export function campoDestino(destino: string): { to: string } | { recipient: string } {
  return esBsuid(destino) ? { recipient: destino } : { to: destino.replace(/\D/g, '') };
}
