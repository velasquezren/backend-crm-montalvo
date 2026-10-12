import { acortar } from '../../common/texto/acortar';
import type { MensajePreparado } from '../../common/whatsapp/interacciones/mensaje-interactivo';
import { bolivianos } from '../cobros/cobro-reglas';
import type { PromocionChat, ServicioPromocion } from '../promociones/promociones.service';

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
/** «Pagar ahora» en una promoción con varios servicios: primero elige cuál. */
export const ELEGIR_SERVICIO = 'ELEGIR_SERVICIO';
/** Paga ESTE servicio. El id viaja en la opción, y la opción solo cuenta si la ofrecimos nosotros. */
const PREFIJO_PAGAR_SERVICIO = 'PAGAR_SERVICIO:';

export const opcionPagarServicio = (servicioId: string) => `${PREFIJO_PAGAR_SERVICIO}${servicioId}`;

/** El servicio que eligió pagar, si la opción es «pagar este servicio». */
export function servicioDeOpcion(seleccionId: string | undefined): string | null {
  return seleccionId?.startsWith(PREFIJO_PAGAR_SERVICIO) ? seleccionId.slice(PREFIJO_PAGAR_SERVICIO.length) || null : null;
}

/** «Octubre Rosa · Ecografía Mamaria»: lo que se cobra, en el QR, en la venta y en la confirmación. */
export function conceptoDeServicio(promocion: string, servicio: string): string {
  return `${promocion} · ${servicio}`.slice(0, 170);
}

/** «*Bs 268* ~Bs 446~»: el precio de promoción y, tachado, el de siempre. */
function precioConAnterior(promocional: number, regular: number | null): string {
  return regular !== null ? `*${bolivianos(promocional)}* ~${bolivianos(regular)}~` : `*${bolivianos(promocional)}*`;
}

/** «2026-10-31» → «31/10/2026». */
function fechaCorta(iso: string): string {
  const [a, m, d] = iso.split('-');
  return `${d}/${m}/${a}`;
}

/** Lo que cabe en el cuerpo de un mensaje con botones de Meta. */
const CUERPO_MAXIMO = 1024;
const PREFIJO_CONDICIONES = '\n\n📋 Condiciones: ';

/**
 * La tarjeta: banner, título, precio (con el anterior si hay oferta), vigencia y
 * condiciones, más los botones. «Pagar ahora» solo si la promoción tiene precio y
 * la línea tiene un QR listo; «Hablar con alguien» siempre.
 *
 * No inventa nada: lo que no está cargado en la promoción no aparece.
 */
export function tarjetaDePromocion(p: PromocionChat, { puedePagar }: { puedePagar: boolean }): MensajePreparado {
  /* Formato de WhatsApp: *negrita* y ~tachado~ para el precio anterior. */
  const precio = p.precio === null
    ? null
    : p.precioPromocional !== null && p.precioRegular !== null
      ? `*${bolivianos(p.precioPromocional)}* ~${bolivianos(p.precioRegular)}~`
      : `*${bolivianos(p.precio)}*`;
  const detalles = [
    ...(precio ? [`💰 ${precio}`] : []),
    /* Con servicios, cada uno con su precio: es lo que trae el banner. */
    ...p.servicios.map(s => `• ${s.nombre}: ${precioConAnterior(s.precioPromocional, s.precioRegular)}`),
    ...(p.vigenteHasta ? [`📅 Válida hasta el ${fechaCorta(p.vigenteHasta)}`] : []),
  ];
  const cabecera = [
    `*${p.titulo}*${p.etiquetaOferta ? ` · ${p.etiquetaOferta}` : ''}`,
    p.resumen,
    ...(detalles.length ? ['', ...detalles] : []),
  ].join('\n');
  /* Las condiciones van al final y se acortan si no caben: la letra chica completa
     está en la página de la promoción y la agente la tiene en el CRM. */
  const resto = CUERPO_MAXIMO - cabecera.length - PREFIJO_CONDICIONES.length;
  const conCondiciones = p.condiciones && resto > 40 ? `${cabecera}${PREFIJO_CONDICIONES}${acortar(p.condiciones, resto)}` : cabecera;
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
      ...(puedePagar && p.servicios.length ? [{ id: ELEGIR_SERVICIO, titulo: 'Pagar ahora' }] : []),
      { id: HABLAR_CON_PERSONA, titulo: 'Hablar con alguien' },
    ],
  };
}

/**
 * La tarjeta de UN servicio de la promoción: la que manda el asistente cuando la
 * paciente pregunta por ese servicio. «Pagar ahora» cobra ese, sin pasar por la lista.
 */
export function tarjetaDeServicio(p: PromocionChat, s: ServicioPromocion, { puedePagar }: { puedePagar: boolean }): MensajePreparado {
  const cabecera = [
    `*${s.nombre}*`,
    `${p.titulo}${p.etiquetaOferta ? ` · ${p.etiquetaOferta}` : ''}`,
    '',
    `💰 ${precioConAnterior(s.precioPromocional, s.precioRegular)}`,
    ...(p.vigenteHasta ? [`📅 Válida hasta el ${fechaCorta(p.vigenteHasta)}`] : []),
  ].join('\n');
  const resto = CUERPO_MAXIMO - cabecera.length - PREFIJO_CONDICIONES.length;
  const conCondiciones = p.condiciones && resto > 40 ? `${cabecera}${PREFIJO_CONDICIONES}${acortar(p.condiciones, resto)}` : cabecera;
  const imagen = p.bannerUrl && /^https:\/\//.test(p.bannerUrl) ? p.bannerUrl : null;
  return {
    tipo: 'botones',
    cuerpo: conCondiciones.length <= CUERPO_MAXIMO ? conCondiciones : cabecera,
    pie: `Código ${p.codigo}`,
    ...(imagen ? { imagenCabecera: imagen } : {}),
    opciones: [
      ...(puedePagar ? [{ id: opcionPagarServicio(s.id), titulo: 'Pagar ahora' }] : []),
      { id: HABLAR_CON_PERSONA, titulo: 'Hablar con alguien' },
    ],
  };
}

/** Título de una fila de lista de WhatsApp: 24 caracteres como mucho. */
const TITULO_FILA = 24;

/**
 * «Pagar ahora» en una promoción con varios servicios: la lista para elegir cuál.
 * El nombre completo y el precio van en la descripción (el título se corta a 24).
 */
export function listaDeServicios(p: PromocionChat): MensajePreparado {
  return {
    tipo: 'lista',
    cuerpo: `¿Qué servicio de *${p.titulo}* quieres pagar? Te mandamos el QR con ese monto.`,
    boton: 'Elegir servicio',
    pie: `Código ${p.codigo}`,
    secciones: [{
      titulo: acortar(p.titulo, TITULO_FILA),
      opciones: p.servicios.slice(0, 10).map(s => ({
        id: opcionPagarServicio(s.id),
        titulo: acortar(s.nombre, TITULO_FILA),
        descripcion: acortar(`${bolivianos(s.precioPromocional)}${s.precioRegular !== null ? ` (antes ${bolivianos(s.precioRegular)})` : ''} · ${s.nombre}`, 72),
      })),
    }],
  };
}

/** «Hablar con alguien» en la tarjeta, si el menú de la línea no tiene su propia confirmación. */
export const TEXTO_PERSONA_TARJETA = 'Listo. Una persona del equipo te escribirá por aquí para ayudarte con esta promoción.';

/** Lo que recibe al mandar el comprobante. No promete plazos: lo verifica una persona. */
export const TEXTO_COMPROBANTE_RECIBIDO = '✅ Recibimos tu comprobante. Una persona del equipo lo verificará y te confirmará el pago por aquí.';

/** Lo que recibe cuando una persona confirma el pago (sale como mensaje de esa persona). */
export function textoPagoConfirmado(titulo: string, monto: number): string {
  return `✅ Confirmamos tu pago de ${bolivianos(monto)} por «${titulo}». ¡Gracias! Si necesitas coordinar una fecha, escríbenos por aquí.`;
}

/** Lo que recibe cuando hay que mandar otro comprobante. El motivo lo escribe la persona que lo revisó. */
export function textoOtroComprobante(motivo: string): string {
  return `No pudimos verificar el comprobante: ${motivo}. Por favor, envíanos otro por aquí.`;
}
