/**
 * Lo que escribe el modelo, llevado al formato de WhatsApp. Los modelos escriben
 * Markdown aunque se les pida otra cosa; en WhatsApp `**así**` se ve con los
 * asteriscos, y un `## Título` se ve con las almohadillas.
 */

/** Más que esto no es una respuesta de chat; se corta en la última frase completa. */
export const LARGO_MAXIMO = 1500;

export function paraWhatsapp(texto: string): string {
  let t = texto
    .replace(/\r\n?/g, '\n')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '_$1_')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (t.length > LARGO_MAXIMO) {
    const corte = t.slice(0, LARGO_MAXIMO);
    const fin = Math.max(corte.lastIndexOf('. '), corte.lastIndexOf('.\n'), corte.lastIndexOf('?'), corte.lastIndexOf('!'));
    t = (fin > LARGO_MAXIMO / 2 ? corte.slice(0, fin + 1) : `${corte.trimEnd()}…`).trim();
  }
  return t;
}

/**
 * La primera respuesta del asistente en una conversación se presenta como lo que
 * es. No se deja al modelo: es una obligación, no un estilo.
 */
export const PRESENTACION = '🤖 _Asistente virtual de la clínica_';

export function conPresentacion(texto: string, presentarse: boolean): string {
  return presentarse ? `${PRESENTACION}\n\n${texto}` : texto;
}
