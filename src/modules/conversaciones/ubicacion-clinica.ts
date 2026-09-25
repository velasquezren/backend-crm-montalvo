/**
 * Ubicación de la clínica y detección de «¿dónde quedan?».
 *
 * Cuando una paciente pregunta cómo llegar, el CRM le manda el pin nativo de
 * WhatsApp —la tarjeta con el mapa que abre Maps o Waze de un toque— y le avisa
 * que enseguida la atiende una persona. No es un bot: responde a esa sola
 * intención y deja todo lo demás a Recepción y a las agentes.
 *
 * Coordenadas del lugar «Clínica Montalvo» en Google Maps (el pin, no el centro
 * del mapa), resueltas desde https://maps.app.goo.gl/CfFbxoEoe2RDmZYT7.
 */
export const UBICACION_CLINICA = {
  latitud: -17.7995078,
  longitud: -63.1998084,
  nombre: 'Clínica Montalvo',
  direccion: 'Universo 641, Santa Cruz de la Sierra',
  enlace: 'https://maps.app.goo.gl/CfFbxoEoe2RDmZYT7',
} as const;

/** Lo que precede al pin. No promete tiempos: puede ser domingo. */
export const TEXTO_UBICACION =
  '¡Con gusto! 📍 Te compartimos la ubicación de Clínica Montalvo. ' +
  'En un momento una persona de nuestro equipo continúa con tu consulta.';

/**
 * Cómo queda el pin en el historial del CRM, y lo que recibe la paciente si
 * Meta rechaza el pin o el worker lo reintenta: texto con el enlace de Maps,
 * que cumple lo mismo.
 */
export const CONTENIDO_PIN = `📍 ${UBICACION_CLINICA.nombre} · ${UBICACION_CLINICA.direccion}\n${UBICACION_CLINICA.enlace}`;

/**
 * Frases que piden la ubicación. Se evalúan sobre el texto normalizado (sin
 * tildes, minúsculas, sin signos), así que «¿Dónde QUEDAN?» y «donde quedan»
 * son lo mismo.
 *
 * Se prefiere callar a contestar de más: un pin que nadie pidió se lee como un
 * bot roto. Por eso «dónde están» solo cuenta si es la pregunta entera —«¿dónde
 * están mis resultados?» es otra cosa— y «dirección» no cuenta si habla de un
 * correo o es la de la propia paciente.
 */
const PIDE_UBICACION: readonly RegExp[] = [
  /\bubicacion(es)?\b/,
  /\bubicad[oa]s?\b/,
  /\bubi\b/,
  /\b(google )?maps?\b/,
  /\bmapa\b/,
  /\bcomo (llego|llegar|puedo llegar|hago para llegar|los encuentro|les encuentro)\b/,
  /\bdonde (queda|quedan|se encuentra|se encuentran|se ubica|se ubican|atienden)\b/,
  /\bdonde es (la clinica|el consultorio)\b/,
  /\bdonde (estan|esta)( ustedes| la clinica( montalvo)?| el consultorio| la sucursal)?$/,
  /\ba ?donde (tengo que ir|debo ir|voy|vengo)\b/,
  /\ben que (zona|calle|barrio|avenida)\b/,
];

const DIRECCION = /\bdireccion\b/;
const DIRECCION_AJENA = /\b(mi|su|tu) direccion\b|\b(correo|email|e mail|mail|electronica)\b/;

/** Minúsculas, sin tildes y sin signos: «¿Dónde están?» → «donde estan». */
export function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ]+/g, ' ')
    .trim();
}

/** ¿El mensaje pregunta dónde está la clínica o cómo llegar? */
export function preguntaPorUbicacion(texto: string): boolean {
  const t = normalizar(texto);
  if (!t) return false;
  if (PIDE_UBICACION.some(patron => patron.test(t))) return true;
  return DIRECCION.test(t) && !DIRECCION_AJENA.test(t);
}
