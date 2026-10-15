/**
 * 15 MB por PDF. Los informes de ecografía, con sus imágenes, pasan de 10 MB y
 * las agentes terminaban pegando el enlace interno del portal, que a la
 * paciente no le abre (pide la sesión de quien lo copió). WhatsApp acepta
 * documentos de hasta 100 MB: el tope es nuestro. Apache (`LimitRequestBody`
 * 25 MB) y multer (20 MB) van por encima a propósito, para que el mensaje de
 * error lo dé el backend y no un 413.
 */
export const BYTES_MAXIMOS_PDF = 15 * 1024 * 1024;

/** Lo que lee la agente cuando se pasa. */
export const AVISO_PDF_GRANDE = 'El PDF pesa más de 15 MB.';
