/**
 * La agenda de un médico como imagen y como texto. Puro y probado: lo que se le
 * manda al médico lo escribe ESTE archivo con los datos de la agenda, no el
 * modelo. Misma mano y mismos colores que el horario (`horario-imagen.ts`).
 *
 * El texto sale siempre —es el pie de la imagen, y es lo que se manda entero si
 * la imagen no se pudo dibujar—: se copia, y lo lee un lector de pantalla.
 */
import type { AgendaDelDia, CitaMedico, EstadoCitaMedico } from '../agenda/agenda-medico-citas';
import { ETIQUETA_ESTADO_CITA } from '../agenda/agenda-medico-citas';
import { ajustar, COLOR, escaparXml } from './horario-imagen';

export const ANCHO_AGENDA = 1080;
/** Más filas que esto no caben en una imagen legible en un teléfono: el resto se cuenta. */
export const FILAS_MAXIMAS = 30;
/** El tope del texto de WhatsApp es 4096; este deja aire para el encabezado. */
const LINEAS_MAXIMAS_TEXTO = 45;

/** El diseño de la imagen: sube cuando cambia el dibujo, para no reusar un PNG viejo. */
export const VERSION_DISENO_AGENDA_MEDICO = 1;

const CABECERA = 300;
const FILA = 92;
const PIE = 100;
const RESUMEN_ALTO = 150;

const COLOR_ESTADO: Readonly<Record<EstadoCitaMedico, { fondo: string; texto: string; borde: string }>> = {
  CONFIRMADA: { fondo: COLOR.fondoSuave, texto: COLOR.primario, borde: COLOR.secundario },
  POR_CONFIRMAR: { fondo: '#FEF3C7', texto: '#92400E', borde: '#F59E0B' },
  PAGO_POR_VERIFICAR: { fondo: '#DBEAFE', texto: '#1E40AF', borde: '#60A5FA' },
};

/** Lo que dice cada recuadro de cantidad, en dos renglones (en plural: es una cuenta, no un estado). */
const RESUMEN_LINEAS: Readonly<Record<EstadoCitaMedico, readonly [string, string]>> = {
  CONFIRMADA: ['Citas', 'confirmadas'],
  POR_CONFIRMAR: ['Por', 'confirmar'],
  PAGO_POR_VERIFICAR: ['Pago por', 'verificar'],
};

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/** «sábado 11 de octubre de 2026», de un AAAA-MM-DD. Sin zona horaria: es una fecha civil. */
export function fechaLarga(fecha: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha);
  if (!m) return fecha;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return `${DIAS[d.getUTCDay()]} ${d.getUTCDate()} de ${MESES[d.getUTCMonth()]} de ${d.getUTCFullYear()}`;
}

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

function pastilla(x: number, y: number, ancho: number, estado: EstadoCitaMedico, texto: string, tamano = 24): string {
  const c = COLOR_ESTADO[estado];
  return [
    `<rect x="${x}" y="${y}" width="${ancho}" height="48" rx="24" fill="${c.fondo}" stroke="${c.borde}" stroke-width="2"/>`,
    `<text x="${x + ancho / 2}" y="${y + 32}" font-size="${tamano}" font-weight="600" fill="${c.texto}" text-anchor="middle">${escaparXml(texto)}</text>`,
  ].join('');
}

export function svgDeAgendaMedico(medico: string, a: AgendaDelDia): string {
  const visibles = a.citas.slice(0, FILAS_MAXIMAS);
  const resto = a.total - visibles.length;
  const cuerpo = a.total === 0 ? 150 : visibles.length * FILA + (resto > 0 ? 70 : 24);
  const alto = CABECERA + RESUMEN_ALTO + cuerpo + PIE;
  const nombre = ajustar(medico, 56, 34, ANCHO_AGENDA - 120);

  const resumen = (['CONFIRMADA', 'POR_CONFIRMAR', 'PAGO_POR_VERIFICAR'] as const).map((estado, i) => {
    const n = estado === 'CONFIRMADA' ? a.confirmadas : estado === 'POR_CONFIRMAR' ? a.porConfirmar : a.pagoPorVerificar;
    const x = 60 + i * 322;
    const c = COLOR_ESTADO[estado];
    return [
      `<rect x="${x}" y="${CABECERA + 20}" width="300" height="110" rx="20" fill="${c.fondo}" stroke="${c.borde}" stroke-width="2"/>`,
      `<text x="${x + 24}" y="${CABECERA + 88}" font-size="60" font-weight="600" fill="${c.texto}">${n}</text>`,
      `<text x="${x + 96}" y="${CABECERA + 68}" font-size="23" fill="${c.texto}">${escaparXml(RESUMEN_LINEAS[estado][0])}</text>`,
      `<text x="${x + 96}" y="${CABECERA + 98}" font-size="23" fill="${c.texto}">${escaparXml(RESUMEN_LINEAS[estado][1])}</text>`,
    ].join('');
  }).join('');

  const y0 = CABECERA + RESUMEN_ALTO;
  const filas = a.total === 0
    ? `<text x="${ANCHO_AGENDA / 2}" y="${y0 + 80}" font-size="32" fill="${COLOR.apagado}" text-anchor="middle">No hay citas registradas para este día</text>`
    : visibles.map((c, i) => {
        const y = y0 + i * FILA;
        const paciente = ajustar(c.paciente, 32, 22, 480);
        return [
          i > 0 ? `<line x1="60" y1="${y}" x2="${ANCHO_AGENDA - 60}" y2="${y}" stroke="${COLOR.borde}" stroke-width="2"/>` : '',
          `<text x="60" y="${y + 58}" font-size="36" font-weight="600" fill="${COLOR.primario}">${escaparXml(c.hora)}</text>`,
          `<text x="220" y="${y + 58}" font-size="${paciente.tamano}" fill="${COLOR.texto}">${escaparXml(paciente.texto)}</text>`,
          pastilla(730, y + 22, 290, c.estado, ETIQUETA_ESTADO_CITA[c.estado], 23),
        ].join('');
      }).join('') + (resto > 0
        ? `<text x="60" y="${y0 + visibles.length * FILA + 46}" font-size="28" fill="${COLOR.apagado}">… y ${escaparXml(plural(resto, 'cita más', 'citas más'))} (están en el texto)</text>`
        : '');

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${ANCHO_AGENDA}" height="${alto}" viewBox="0 0 ${ANCHO_AGENDA} ${alto}" font-family="Poppins">`,
    `<rect width="100%" height="100%" fill="#FFFFFF"/>`,
    `<rect width="100%" height="${CABECERA}" fill="${COLOR.primario}"/>`,
    `<text x="60" y="80" font-size="28" fill="#FFFFFF" fill-opacity="0.85" letter-spacing="3">AGENDA DEL DÍA</text>`,
    `<text x="60" y="${176 - (56 - nombre.tamano) / 2}" font-size="${nombre.tamano}" font-weight="600" fill="#FFFFFF">${escaparXml(nombre.texto)}</text>`,
    `<text x="60" y="240" font-size="32" fill="#FFFFFF" fill-opacity="0.9">${escaparXml(fechaLarga(a.fecha))}</text>`,
    resumen,
    filas,
    `<rect y="${alto - PIE}" width="100%" height="${PIE}" fill="${COLOR.fondoSuave}"/>`,
    `<text x="60" y="${alto - PIE + 44}" font-size="28" font-weight="600" fill="${COLOR.primario}">Clínica Montalvo</text>`,
    `<text x="60" y="${alto - PIE + 80}" font-size="22" fill="${COLOR.apagado}">Confidencial: datos de pacientes, solo para el médico.</text>`,
    '</svg>',
  ].join('');
}
