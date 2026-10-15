/**
 * Reservar una cita desde el asistente: lo que el CÓDIGO comprueba antes de
 * escribir en la agenda. Puro: sin base ni red, y se prueba.
 *
 * El modelo propone la reserva (médico, día, hora, nombre y CI); no la decide.
 * Antes de que el CRM la registre:
 *
 * - La línea la tiene habilitada (`ASISTENTE_RESERVAS_LINEAS`, falla CERRADO).
 * - El nombre y el CI los ESCRIBIÓ ella en este chat (`datosNoDichos`): el
 *   modelo no puede deducirlos, completarlos ni inventarlos.
 * - La hora está libre en la agenda en ese momento (lo mira la herramienta).
 * - El teléfono es el de la conversación, nunca un parámetro.
 *
 * Lo que se le manda después (número de reserva, monto y QR del médico) lo arma
 * el código, como en el Flow de reserva: el modelo no escribe montos ni QR.
 */
import { fechaLarga } from '../agenda/agenda-flow.service';

/**
 * ¿Esta línea reserva por el asistente? Ids separados por coma, o `todas` escrito
 * a propósito. Vacía o ausente: ninguna. Igual que `WHATSAPP_INTERACCIONES_LINEAS`.
 */
export function reservasDelAsistenteEn(valor: string | undefined, lineaId: string): boolean {
  const v = (valor ?? '').trim();
  if (v === 'todas') return true;
  return v.split(',').map(s => s.trim()).filter(Boolean).includes(lineaId);
}

/** Minúsculas, sin tildes y con todo lo que no es letra o número como espacio. */
function normalizar(texto: string): string {
  return texto.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Los números que escribió, juntando los separadores que se usan en un carnet («11.340.617», «1134-0617»). */
function numerosDe(texto: string): Set<string> {
  return new Set(texto.replace(/(\d)[.\- ](?=\d)/g, '$1').match(/\d+/g) ?? []);
}

/**
 * `null` si el nombre y el CI salen de lo que ELLA escribió; si no, lo que el
 * modelo tiene que hacer (se le devuelve tal cual, para que se corrija).
 *
 * - Nombre: al menos nombre y apellido, y cada palabra está en sus mensajes.
 * - CI: sus dígitos (5 o más) son un número que ella escribió. La extensión
 *   («LP», «SC») no se exige: muchas no la ponen.
 */
export function datosNoDichos(nombre: string, ci: string, textoDeLaPaciente: string): string | null {
  const dichas = new Set(normalizar(textoDeLaPaciente).split(' '));
  const palabras = normalizar(nombre).split(' ').filter(p => p.length >= 2);
  if (palabras.length < 2) return 'Falta el nombre completo (nombre y apellido) de quien viene a la consulta: pídeselo.';
  if (palabras.some(p => !dichas.has(p))) {
    return 'Ese nombre no es el que ella escribió en el chat. Usa exactamente el que te dio; si no te lo dio, pídeselo.';
  }
  const digitos = ci.replace(/\D/g, '');
  if (digitos.length < 5) return 'Falta el número de carnet (CI) de quien viene a la consulta: pídeselo.';
  if (!numerosDe(textoDeLaPaciente).has(digitos)) {
    return 'Ese carnet no es el que ella escribió en el chat. Usa exactamente el que te dio; si no te lo dio, pídeselo.';
  }
  return null;
}

/** «lunes 19 de octubre», sin la coma de `fechaLarga`: va en medio de una frase. */
const dia = (fecha: string) => fechaLarga(fecha).replace(',', '');

/** «con Dr. Juan Carlos Montalvo el lunes 19 de octubre a las 12:00». */
export function resumenDeReserva(r: { readonly medico: string; readonly fecha: string; readonly hora: string }): string {
  return `con ${r.medico} el ${dia(r.fecha)} a las ${r.hora}`;
}

/** Se ocupó la hora entre que la vio libre y la reservó: las que quedan, o que ese día ya no hay. */
export function textoHoraOcupada(r: { readonly fecha: string; readonly hora: string }, libres: readonly string[]): string {
  return libres.length
    ? `Las ${r.hora} del ${dia(r.fecha)} se acaban de ocupar 😕. Ese día todavía quedan:\n${libres.slice(0, 12).map(h => `• ${h}`).join('\n')}\n\n¿Cuál prefieres?`
    : `Las ${r.hora} del ${dia(r.fecha)} se acaban de ocupar 😕 y ese día ya no quedan horas libres. ¿Te busco otro día?`;
}
