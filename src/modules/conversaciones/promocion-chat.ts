import { acortar } from '../../common/texto/acortar';
import type { MensajePreparado } from '../../common/whatsapp/interacciones/mensaje-interactivo';
import { bolivianos } from '../cobros/cobro-reglas';
import type { PromocionChat } from '../promociones/promociones.service';

/*
 * Una promoción dentro del chat (docs/pagos-promocion.md): reconocer su código,
 * mostrar su tarjeta y los textos del pago. Solo decisiones, sin base ni red.
 */

/** «PRM-7K3QX»: el alfabeto de `generarCodigo` (sin 0/O ni 1/I/L). */
const CODIGO = /\bPRM-([2-9A-HJ-NP-Z]{5})\b/i;

/** El código de promoción que trae un mensaje (el enlace de la landing lo escribe), en mayúsculas. */
export function codigoEnTexto(texto: string): string | null {
  const m = CODIGO.exec(texto);
  return m ? `PRM-${m[1].toUpperCase()}` : null;
}

/** Los ids de los botones de la tarjeta. Solo cuentan si vienen de NUESTRA tarjeta (correlación). */
export const PAGAR_PROMOCION = 'PAGAR_PROMOCION';
export const HABLAR_CON_PERSONA = 'TALK_TO_HUMAN';

/** «2026-10-31» → «31/10/2026». */
function fechaCorta(iso: string): string {
  const [a, m, d] = iso.split('-');
  return `${d}/${m}/${a}`;
}

/** Lo que cabe en el cuerpo de un mensaje con botones de Meta. */
const CUERPO_MAXIMO = 1024;

/**
 * La tarjeta: banner, título, precio (con el anterior si hay oferta), vigencia y
 * condiciones, más los botones. «Pagar ahora» solo si la promoción tiene precio y
 * la línea tiene un QR listo; «Hablar con alguien» siempre.
 *
 * No inventa nada: lo que no está cargado en la promoción no aparece.
 */
export function tarjetaDePromocion(p: PromocionChat, { puedePagar }: { puedePagar: boolean }): MensajePreparado {
  const precio = p.precio === null
    ? null
    : p.precioPromocional !== null && p.precioRegular !== null
      ? `${bolivianos(p.precioPromocional)} (antes ${bolivianos(p.precioRegular)})`
      : bolivianos(p.precio);
  const cabecera = [
    `*${p.titulo}*${p.etiquetaOferta ? ` · ${p.etiquetaOferta}` : ''}`,
    p.resumen,
    ...(precio ? [`Precio: ${precio}`] : []),
    ...(p.vigenteHasta ? [`Válida hasta el ${fechaCorta(p.vigenteHasta)}`] : []),
  ].join('\n');
  /* Las condiciones van al final y se acortan si no caben: la letra chica completa
     está en la página de la promoción y la agente la tiene en el CRM. */
  const resto = CUERPO_MAXIMO - cabecera.length - '\n\nCondiciones: '.length;
  const conCondiciones = p.condiciones && resto > 40 ? `${cabecera}\n\nCondiciones: ${acortar(p.condiciones, resto)}` : cabecera;
  /* `acortar` cuenta caracteres y Meta cuenta unidades UTF-16: con muchos emojis
     podría pasarse; entonces van sin condiciones antes que no ir. */
  const cuerpo = conCondiciones.length <= CUERPO_MAXIMO ? conCondiciones : cabecera;
  const imagen = p.bannerUrl && /^https:\/\//.test(p.bannerUrl) ? p.bannerUrl : null;
  return {
    tipo: 'botones',
    cuerpo,
    pie: `Código ${p.codigo}`,
    ...(imagen ? { imagenCabecera: imagen } : {}),
    opciones: [
      ...(puedePagar && p.precio !== null ? [{ id: PAGAR_PROMOCION, titulo: 'Pagar ahora' }] : []),
      { id: HABLAR_CON_PERSONA, titulo: 'Hablar con alguien' },
    ],
  };
}

/** Lo que recibe al mandar el comprobante. No promete plazos: lo verifica una persona. */
export const TEXTO_COMPROBANTE_RECIBIDO = 'Recibimos tu comprobante. Una persona del equipo lo verificará y te confirmará el pago por aquí.';

/** Lo que recibe cuando una persona confirma el pago (sale como mensaje de esa persona). */
export function textoPagoConfirmado(titulo: string, monto: number): string {
  return `Confirmamos tu pago de ${bolivianos(monto)} por «${titulo}». ¡Gracias! Si necesitas coordinar una fecha, escríbenos por aquí.`;
}

/** Lo que recibe cuando hay que mandar otro comprobante. El motivo lo escribe la persona que lo revisó. */
export function textoOtroComprobante(motivo: string): string {
  return `No pudimos verificar el comprobante: ${motivo}. Por favor, envíanos otro por aquí.`;
}
