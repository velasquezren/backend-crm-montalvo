import { ContenidoMensaje } from '../../common/whatsapp/whatsapp-cloud.service';

/** Lo que el CRM sabe de un adjunto guardado en R2. */
export interface AdjuntoSaliente {
  key: string;
  mime?: string | null;
  nombre?: string | null;
}

/**
 * Las únicas imágenes que WhatsApp acepta como `image`. Un WebP, GIF o HEIC
 * mandado así lo rechaza Meta: sale como documento y llega igual.
 */
const MIME_IMAGEN = new Set(['image/jpeg', 'image/png']);

/** Tope de Meta para la descripción de una imagen o documento. */
const MAX_DESCRIPCION = 1024;

/**
 * El adjunto tal como lo espera Meta.
 *
 * Tres fallos que corrige (2026-09-23):
 * - El **texto** que la agente escribía con una foto no le llegaba al
 *   paciente: se mandaba `{ image: { link } }` sin `caption`. Ella veía la
 *   foto con su comentario en el hilo; la paciente, solo la foto.
 * - El tipo se decidía por la **extensión** de la clave (`/\.pdf$/`), no por
 *   `mediaMime`: un `.docx` de Mi Memoria salía como imagen y Meta lo rechazaba.
 * - El **nombre** de un documento era el texto del mensaje: «Aquí su receta»,
 *   sin `.pdf`, en vez del archivo.
 *
 * Los mensajes viejos no guardaban `mediaMime`: para ellos se deduce de la
 * extensión, que es lo que se hacía antes.
 */
export function contenidoAdjunto(url: string, adjunto: AdjuntoSaliente, texto: string): ContenidoMensaje {
  const mime = (adjunto.mime ?? mimePorExtension(adjunto.key)).toLowerCase();
  const descripcion = texto.trim() ? { caption: texto.trim().slice(0, MAX_DESCRIPCION) } : {};
  if (MIME_IMAGEN.has(mime)) return { type: 'image', image: { link: url, ...descripcion } };
  return { type: 'document', document: { link: url, filename: nombreArchivo(adjunto), ...descripcion } };
}

function mimePorExtension(key: string): string {
  const ext = /\.([a-z0-9]+)(?:\?.*)?$/i.exec(key)?.[1]?.toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'pdf') return 'application/pdf';
  return 'application/octet-stream';
}

function nombreArchivo(adjunto: AdjuntoSaliente): string {
  if (adjunto.nombre?.trim()) return adjunto.nombre.trim();
  const ext = /\.([a-z0-9]+)(?:\?.*)?$/i.exec(adjunto.key)?.[1];
  return ext ? `Documento.${ext.toLowerCase()}` : 'Documento';
}
