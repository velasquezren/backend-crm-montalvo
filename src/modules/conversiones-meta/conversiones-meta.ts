/**
 * Lo puro del aviso de ventas a Meta: decidir si una venta se avisa, armar el
 * evento y leer la respuesta. Sin red ni base, para probarlo por sí solo.
 *
 * Contrato de Meta (Conversions API para Business Messaging, Click-to-WhatsApp):
 * `POST /{dataset_id}/events` con `action_source: business_messaging`,
 * `messaging_channel: whatsapp` y, en `user_data`, la WABA y el `ctwa_clid` del
 * clic. **Meta no deduplica estos eventos**: lo garantiza el CRM (una fila por
 * venta, y lo incierto no se reenvía solo). Ver docs/conversiones-meta.md.
 */

/** Cuánto se espera tras la venta antes de avisar: deja anularla o corregir su lead. */
export const ESPERA_ANTES_DE_AVISAR_MS = 60 * 60 * 1000;
/**
 * Un clic más viejo que esto no se atribuye: la ventana de atribución de Meta
 * para mensajería es de 7 días, y un evento más viejo que eso tampoco se admite.
 */
export const VENTANA_DIAS = 7;
const VENTANA_MS = VENTANA_DIAS * 24 * 60 * 60 * 1000;
/** Moneda única del CRM (`Venta.monto`). */
const MONEDA = 'BOB';

/** El clic del anuncio que guarda la ficha (`Cliente.datosExtra.campanaOrigen`). */
export interface ClicDeAnuncio {
  readonly clickId: string;
  readonly anuncioId: string | null;
  readonly fecha: Date | null;
}

/** Lo que hace falta leer de la venta para decidir. */
export interface VentaParaAvisar {
  readonly id: string;
  readonly estado: string;
  readonly monto: number;
  readonly lead: { readonly anuncioId: string | null; readonly metaLeadId: string | null; readonly wabaId: string | null } | null;
  readonly clic: ClicDeAnuncio | null;
}

export interface EventoCompra {
  readonly event_name: 'Purchase';
  readonly event_time: number;
  readonly event_id: string;
  readonly action_source: 'business_messaging';
  readonly messaging_channel: 'whatsapp';
  readonly user_data: { readonly whatsapp_business_account_id: string; readonly ctwa_clid: string };
  readonly custom_data: { readonly currency: string; readonly value: number };
}

export type Decision = { readonly avisar: true; readonly evento: EventoCompra } | { readonly avisar: false; readonly motivo: string };

/** El clic guardado en la ficha, o null si no hay uno usable. */
export function clicDeLaFicha(datosExtra: unknown): ClicDeAnuncio | null {
  const campana = (datosExtra as { campanaOrigen?: unknown } | null)?.campanaOrigen as
    | { clickId?: unknown; anuncioId?: unknown; fecha?: unknown } | undefined;
  if (!campana || typeof campana.clickId !== 'string' || !campana.clickId) return null;
  const fecha = typeof campana.fecha === 'string' ? new Date(campana.fecha) : null;
  return {
    clickId: campana.clickId,
    anuncioId: typeof campana.anuncioId === 'string' ? campana.anuncioId : null,
    fecha: fecha && !Number.isNaN(fecha.getTime()) ? fecha : null,
  };
}

/**
 * ¿Se le avisa a Meta esta venta, y con qué evento? Se decide al ENVIAR, con los
 * datos de ese momento. Solo lo mínimo: el clic, la WABA, el monto y la hora; ni
 * el producto, ni el médico, ni nada de la paciente.
 */
export function decidirAviso(venta: VentaParaAvisar | null, ocurridoEn: Date, ahora: Date): Decision {
  if (!venta) return { avisar: false, motivo: 'La venta ya no existe' };
  if (venta.estado !== 'GANADA') return { avisar: false, motivo: `La venta está ${venta.estado}, no GANADA` };
  if (!venta.lead) return { avisar: false, motivo: 'Sin lead de origen' };
  /* Un formulario instantáneo se avisa con su leadgen_id por otro camino de Meta. */
  if (venta.lead.metaLeadId) return { avisar: false, motivo: 'El lead es de un formulario de Meta, no de Click-to-WhatsApp' };
  if (!venta.lead.anuncioId) return { avisar: false, motivo: 'El lead no vino de un anuncio' };
  if (!venta.clic) return { avisar: false, motivo: 'La ficha no guarda el ctwa_clid del clic' };
  /* La ficha guarda solo el ÚLTIMO clic: si es de otro anuncio, no es el que trajo esta venta. */
  if (venta.clic.anuncioId !== venta.lead.anuncioId) return { avisar: false, motivo: 'El último clic guardado es de otro anuncio' };
  if (venta.clic.fecha && ocurridoEn.getTime() - venta.clic.fecha.getTime() > VENTANA_MS) {
    return { avisar: false, motivo: `La venta llegó a más de ${VENTANA_DIAS} días del clic` };
  }
  if (ahora.getTime() - ocurridoEn.getTime() > VENTANA_MS) return { avisar: false, motivo: `La venta tiene más de ${VENTANA_DIAS} días` };
  if (!venta.lead.wabaId) return { avisar: false, motivo: 'La línea de la conversación no tiene WABA' };
  if (!(venta.monto > 0)) return { avisar: false, motivo: 'La venta no tiene monto' };
  return {
    avisar: true,
    evento: {
      event_name: 'Purchase',
      event_time: Math.floor(ocurridoEn.getTime() / 1000),
      event_id: venta.id,
      action_source: 'business_messaging',
      messaging_channel: 'whatsapp',
      user_data: { whatsapp_business_account_id: venta.lead.wabaId, ctwa_clid: venta.clic.clickId },
      custom_data: { currency: MONEDA, value: Math.round(venta.monto * 100) / 100 },
    },
  };
}

/**
 * Códigos de Graph API que dicen «ahora no, más tarde»: límites de uso y fallos
 * transitorios declarados por Meta. Esos no se procesaron y se pueden reintentar
 * sin duplicar nada. Cualquier otro 4xx es un rechazo del evento.
 */
const CODIGOS_REINTENTABLES = new Set([1, 2, 4, 17, 32, 341, 613]);

export type ResultadoAviso =
  | { readonly estado: 'ENVIADO'; readonly fbtraceId: string | null }
  | { readonly estado: 'REINTENTAR'; readonly motivo: string }
  | { readonly estado: 'FALLIDO'; readonly motivo: string }
  | { readonly estado: 'INCIERTO'; readonly motivo: string };

/** Lee la respuesta de Meta. Un 5xx es incierto: Meta pudo procesarlo antes de fallar. */
export function leerRespuesta(status: number, cuerpo: unknown): ResultadoAviso {
  const datos = (cuerpo ?? {}) as { events_received?: unknown; fbtrace_id?: unknown; error?: { code?: unknown; message?: unknown; fbtrace_id?: unknown } };
  if (status >= 200 && status < 300) {
    return Number(datos.events_received) >= 1
      ? { estado: 'ENVIADO', fbtraceId: typeof datos.fbtrace_id === 'string' ? datos.fbtrace_id : null }
      : { estado: 'FALLIDO', motivo: 'Meta respondió sin recibir el evento' };
  }
  if (status >= 500) return { estado: 'INCIERTO', motivo: `Meta respondió ${status}` };
  const codigo = typeof datos.error?.code === 'number' ? datos.error.code : null;
  const mensaje = typeof datos.error?.message === 'string' ? datos.error.message : 'sin detalle';
  const motivo = `Meta respondió ${status}${codigo !== null ? ` (código ${codigo})` : ''}: ${mensaje}`.slice(0, 300);
  return status === 429 || (codigo !== null && CODIGOS_REINTENTABLES.has(codigo))
    ? { estado: 'REINTENTAR', motivo }
    : { estado: 'FALLIDO', motivo };
}
