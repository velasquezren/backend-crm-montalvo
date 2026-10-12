/**
 * La agenda de un médico como imagen y como texto. Puro y probado: lo que se le
 * manda al médico lo escribe ESTE archivo con los datos de la agenda, no el
 * modelo. Misma mano que el horario y la constancia (`marca-imagen.ts`): mañana y
 * tarde por separado, y el estado de cada cita en color y en palabras.
 *
 * El texto sale siempre —es el pie de la imagen, y es lo que se manda entero si
 * la imagen no se pudo dibujar—: se copia, y lo lee un lector de pantalla.
 */
import type { AgendaDelDia, CitaMedico, EstadoCitaMedico } from '../agenda/agenda-medico-citas';
import { ETIQUETA_ESTADO_CITA, minutosDeHora } from '../agenda/agenda-medico-citas';
import {
  abrirSvg, ajustar, ALTO_MARCA, ANCHO_IMAGEN, antetitulo, cabecera, COLOR, escaparXml, fechaLarga, MARGEN, pastilla, pie, tituloSeccion,
} from './marca-imagen';
import { INICIO_TARDE_MINUTO } from './horario-imagen';

export { fechaLarga } from './marca-imagen';

export const ANCHO_AGENDA = ANCHO_IMAGEN;
/** Más filas que esto no caben en una imagen legible en un teléfono: el resto se cuenta. */
export const FILAS_MAXIMAS = 30;
/** El tope del texto de WhatsApp es 4096; este deja aire para el encabezado. */
const LINEAS_MAXIMAS_TEXTO = 45;

/** El diseño de la imagen: sube cuando cambia el dibujo, para no reusar un PNG viejo. */
export const VERSION_DISENO_AGENDA_MEDICO = 2;

const CABECERA = 360;
const RESUMEN_ALTO = 158;
const SECCION = 70;
const FILA = 88;
const PIE = 140;

const COLOR_ESTADO: Readonly<Record<EstadoCitaMedico, { fondo: string; texto: string; borde: string }>> = {
  CONFIRMADA: { fondo: COLOR.fondoSuave, texto: COLOR.primario, borde: COLOR.secundario },
  POR_CONFIRMAR: { fondo: COLOR.ambarFondo, texto: COLOR.ambarTexto, borde: COLOR.ambarBorde },
  PAGO_POR_VERIFICAR: { fondo: COLOR.azulFondo, texto: COLOR.azulTexto, borde: COLOR.azulBorde },
};
/** Un recuadro de cantidad en cero no compite con los que sí tienen algo. */
const SIN_NADA = { fondo: COLOR.fondoGris, texto: COLOR.apagado, borde: COLOR.borde };

/** Lo que dice cada recuadro de cantidad, en dos renglones (en plural: es una cuenta, no un estado). */
const RESUMEN_LINEAS: Readonly<Record<EstadoCitaMedico, readonly [string, string]>> = {
  CONFIRMADA: ['Citas', 'confirmadas'],
  POR_CONFIRMAR: ['Por', 'confirmar'],
  PAGO_POR_VERIFICAR: ['Pago por', 'verificar'],
};

const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

/** «3 citas: 2 confirmadas y 1 pendiente», o que no hay. */
export function resumenEnPalabras(a: AgendaDelDia): string {
  if (a.total === 0) return 'No hay citas registradas.';
  const partes = [
    a.confirmadas > 0 ? plural(a.confirmadas, 'confirmada', 'confirmadas') : '',
    a.pendientes > 0 ? plural(a.pendientes, 'pendiente', 'pendientes') : '',
  ].filter(Boolean);
  return `${plural(a.total, 'cita', 'citas')}: ${partes.join(' y ')}.`;
}

const encabezado = (medico: string, a: AgendaDelDia) => `🗓️ *Agenda de ${medico}*\n${fechaLarga(a.fecha)}`;

function desglose(a: AgendaDelDia): string {
  return [
    `• Confirmadas: ${a.confirmadas}`,
    `• Por confirmar: ${a.porConfirmar}`,
    `• Pago por verificar: ${a.pagoPorVerificar}`,
  ].join('\n');
}

const NOTA_PENDIENTES = '_«Por confirmar» y «Pago por verificar» son reservas que recepción todavía no cerró._';

/** Solo las cantidades (la pregunta «¿cuántas citas tengo?»). */
export function textoResumen(medico: string, a: AgendaDelDia): string {
  if (a.total === 0) return `${encabezado(medico, a)}\n\nNo tienes citas registradas para este día.`;
  return [encabezado(medico, a), '', resumenEnPalabras(a), desglose(a), ...(a.pendientes > 0 ? ['', NOTA_PENDIENTES] : [])].join('\n');
}

const lineaDeCita = (c: CitaMedico) => `${c.hora} · ${c.paciente} · ${ETIQUETA_ESTADO_CITA[c.estado]}`;

/** El pie de la imagen: el resumen, sin la lista (que ya está dibujada y un pie largo se corta). */
export function pieDeLaImagen(medico: string, a: AgendaDelDia): string {
  return [encabezado(medico, a), '', resumenEnPalabras(a), ...(a.pendientes > 0 ? ['', NOTA_PENDIENTES] : [])].join('\n');
}

/** Cuando no hay imagen: el listado entero en texto, con tope y avisando lo que no cabe. */
export function textoListado(medico: string, a: AgendaDelDia): string {
  if (a.total === 0) return textoResumen(medico, a);
  const lineas = a.citas.slice(0, LINEAS_MAXIMAS_TEXTO).map(lineaDeCita);
  const resto = a.total - lineas.length;
  return [
    encabezado(medico, a), '', resumenEnPalabras(a), '',
    ...lineas,
    ...(resto > 0 ? [`… y ${plural(resto, 'cita más', 'citas más')}.`] : []),
    ...(a.pendientes > 0 ? ['', NOTA_PENDIENTES] : []),
  ].join('\n');
}

/** Una hora ilegible cuenta como de la mañana: se ve igual, solo cambia de sección. */
const minutos = (hora: string) => minutosDeHora(hora) ?? 0;

function filaDeCita(c: CitaMedico, y: number, primera: boolean): string {
  const estilo = COLOR_ESTADO[c.estado];
  const paciente = ajustar(c.paciente, 30, 27, 470);
  return [
    primera ? '' : `<line x1="${MARGEN}" y1="${y}" x2="${ANCHO_AGENDA - MARGEN}" y2="${y}" stroke="${COLOR.borde}" stroke-width="2"/>`,
    /* La franja de color repite el estado: se distingue de reojo, sin leer la pastilla. */
    `<rect x="${MARGEN}" y="${y + 18}" width="6" height="${FILA - 36}" rx="3" fill="${estilo.borde}"/>`,
    `<text x="${MARGEN + 26}" y="${y + 56}" font-size="34" font-weight="600" fill="${COLOR.primario}">${escaparXml(c.hora)}</text>`,
    `<text x="${MARGEN + 172}" y="${y + 55}" font-size="${paciente.tamano}" fill="${COLOR.texto}">${escaparXml(paciente.texto)}</text>`,
    pastilla(ANCHO_AGENDA - MARGEN - 270, y + 20, 270, 48, ETIQUETA_ESTADO_CITA[c.estado], estilo, 22),
  ].join('');
}

export function svgDeAgendaMedico(medico: string, a: AgendaDelDia): string {
  const visibles = a.citas.slice(0, FILAS_MAXIMAS);
  const resto = a.total - visibles.length;
  const secciones = [
    { titulo: 'Mañana', citas: visibles.filter(c => minutos(c.hora) < INICIO_TARDE_MINUTO) },
    { titulo: 'Tarde', citas: visibles.filter(c => minutos(c.hora) >= INICIO_TARDE_MINUTO) },
  ].filter(s => s.citas.length > 0);
  const cuerpo = a.total === 0 ? 170 : secciones.reduce((s, x) => s + SECCION + x.citas.length * FILA, 0) + (resto > 0 ? 70 : 20);
  const alto = CABECERA + RESUMEN_ALTO + cuerpo + PIE;
  /* El total va a la derecha de la cabecera: el nombre no puede pisarlo. */
  const nombre = ajustar(medico, 54, 32, ANCHO_AGENDA - 2 * MARGEN - 190);

  const resumen = (['CONFIRMADA', 'POR_CONFIRMAR', 'PAGO_POR_VERIFICAR'] as const).map((estado, i) => {
    const n = estado === 'CONFIRMADA' ? a.confirmadas : estado === 'POR_CONFIRMAR' ? a.porConfirmar : a.pagoPorVerificar;
    const x = MARGEN + i * 327;
    const c = n > 0 ? COLOR_ESTADO[estado] : SIN_NADA;
    const y = CABECERA + 28;
    return [
      `<rect x="${x}" y="${y}" width="306" height="110" rx="20" fill="${c.fondo}" stroke="${c.borde}" stroke-width="2"/>`,
      `<text x="${x + 28}" y="${y + 76}" font-size="58" font-weight="600" fill="${c.texto}">${n}</text>`,
      `<text x="${x + (n > 9 ? 116 : 100)}" y="${y + 50}" font-size="23" fill="${c.texto}">${escaparXml(RESUMEN_LINEAS[estado][0])}</text>`,
      `<text x="${x + (n > 9 ? 116 : 100)}" y="${y + 80}" font-size="23" fill="${c.texto}">${escaparXml(RESUMEN_LINEAS[estado][1])}</text>`,
    ].join('');
  }).join('');

  let y = CABECERA + RESUMEN_ALTO;
  let filas = '';
  if (a.total === 0) {
    filas = `<text x="${ANCHO_AGENDA / 2}" y="${y + 95}" font-size="32" fill="${COLOR.apagado}" text-anchor="middle">No hay citas registradas para este día</text>`;
  } else {
    for (const s of secciones) {
      filas += tituloSeccion(s.titulo, y + 46, plural(s.citas.length, 'cita', 'citas'));
      y += SECCION;
      s.citas.forEach((c, i) => {
        filas += filaDeCita(c, y, i === 0);
        y += FILA;
      });
    }
    if (resto > 0) {
      filas += `<text x="${MARGEN}" y="${y + 48}" font-size="26" fill="${COLOR.apagado}">… y ${escaparXml(plural(resto, 'cita más', 'citas más'))} (están en el texto)</text>`;
    }
  }

  return [
    abrirSvg(alto),
    cabecera(CABECERA),
    antetitulo('Agenda del día', ALTO_MARCA + 62),
    `<text x="${MARGEN}" y="${ALTO_MARCA + 128 - (54 - nombre.tamano) / 2}" font-size="${nombre.tamano}" font-weight="600" fill="#FFFFFF">${escaparXml(nombre.texto)}</text>`,
    `<text x="${MARGEN}" y="${ALTO_MARCA + 180}" font-size="30" fill="#FFFFFF" fill-opacity="0.9">${escaparXml(fechaLarga(a.fecha))}</text>`,
    `<text x="${ANCHO_AGENDA - MARGEN}" y="${ALTO_MARCA + 128}" font-size="76" font-weight="600" fill="#FFFFFF" text-anchor="end">${a.total}</text>`,
    `<text x="${ANCHO_AGENDA - MARGEN}" y="${ALTO_MARCA + 170}" font-size="24" fill="#FFFFFF" fill-opacity="0.85" text-anchor="end">${a.total === 1 ? 'cita' : 'citas'}</text>`,
    resumen,
    filas,
    pie(alto, PIE, 'Confidencial: solo para el médico', 'Por confirmar y Pago por verificar: reservas que recepción aún no cerró.'),
    '</svg>',
  ].join('');
}
