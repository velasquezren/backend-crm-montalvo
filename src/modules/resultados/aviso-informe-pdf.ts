/*
 * «Recibir PDF» en el aviso de resultado (docs/informes-por-whatsapp.md). Sin
 * imports a propósito: lo leen la correlación de respuestas, la ingesta y el
 * servicio de informes, y ninguno puede depender de otro servicio por esto.
 */

/** El `payload` del botón de respuesta rápida y la selección que deja al tocarlo. */
export const RESPUESTA_PDF_AVISO = 'AVISO_INFORME_PDF';

/** Dos toques seguidos del mismo aviso mandan un solo PDF. */
export const ESPERA_ENTRE_PDF_DEL_AVISO_MS = 10 * 60_000;

/**
 * ¿El toque es el «Recibir PDF» del aviso? Por el `payload` que puso el CRM o,
 * si la plantilla salió sin él (catálogo de Meta sin responder), por el rótulo:
 * Meta devuelve entonces el texto del botón. Quién lo tocó y de qué aviso lo
 * decide el mensaje al que responde, nunca este texto.
 */
export function pideElPdfDelAviso(seleccion: { id: string; titulo: string }): boolean {
  if (seleccion.id === RESPUESTA_PDF_AVISO) return true;
  const rotulo = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  return rotulo(seleccion.id) === 'recibir pdf' || rotulo(seleccion.titulo) === 'recibir pdf';
}
