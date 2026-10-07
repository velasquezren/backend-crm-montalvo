import type { MensajePreparado } from '../../common/whatsapp/interacciones/mensaje-interactivo';
import type { OfertaInteraccion } from './interacciones-integracion';

/** Identificadores internos, nunca el texto editable del botón. No clasifica
 * texto libre ni convierte un Flow de solicitud de cita en una promoción. */
export function esInteraccionComercial(mensaje: MensajePreparado): boolean {
  const opciones = mensaje.tipo === 'botones' ? mensaje.opciones
    : mensaje.tipo === 'lista' ? mensaje.secciones.flatMap(s => s.opciones) : [];
  return opciones.some(o => ['VIEW_PROMOTIONS', 'REGISTER_INTEREST', 'PAGAR_PROMOCION'].includes(o.id) || o.id.startsWith('PROMO_'));
}

/** También cubre snapshots creados antes de separar las líneas. */
export function esOfertaComercial(oferta: OfertaInteraccion): boolean {
  return oferta.origen === 'PROMOCION' || !!oferta.promocionId || esInteraccionComercial(oferta.mensaje);
}
