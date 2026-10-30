/**
 * La constancia que recibe la paciente cuando el comprobante de su reserva queda
 * registrado en la agenda: una imagen con el número, el día, la hora y el médico,
 * y el mismo resumen en texto como pie (o solo, si no hay imagen). Puro y
 * probado; lo manda `ConstanciaReservaService`.
 *
 * Lo que NO dice es tan importante como lo que dice: `PAGADO` en la agenda es
 * «comprobante cargado», no «pago verificado» (docs/reservas-pago-chat.md). Por
 * eso el estado es «Pago recibido: en verificación» y nunca «confirmada»: la cita
 * la confirma recepción, como siempre.
 *
 * Sin carnet, teléfono ni nada que no sea de la cita: la imagen se guarda y se
 * reenvía.
 */
import { abrirSvg, ajustar, ANCHO_IMAGEN, COLOR, escaparXml, fechaLarga, logo, MARGEN, partesDeFecha } from '../asistente/marca-imagen';
import { NOMBRE_CLINICA } from '../asistente/prompt-sistema';
import { textoBolivianos } from '../asistente/horario-imagen';
import { UBICACION_CLINICA } from './ubicacion-clinica';

export interface DatosConstancia {
  /** `para_agendar.para_age`. */
  readonly reserva: number;
  /** AAAA-MM-DD. */
  readonly fecha: string;
  /** HH:MM, hora de Bolivia. */
  readonly hora: string;
  readonly paciente: string;
  readonly medico: string;
  readonly especialidad: string | null;
  /** Lo que se le pidió pagar con el QR, en bolivianos. */
  readonly montoBs: number | null;
}

/**
 * El diseño de la imagen: sube cuando cambia el dibujo, para no reusar un PNG viejo.
 * 3 (28/10/2026): hoja blanca de comprobante, sin la franja verde ni la caja ámbar.
 */
export const VERSION_DISENO_CONSTANCIA = 3;

export const ESTADO_CONSTANCIA = 'Pago recibido: en verificación';
const AVISO_CONSTANCIA = 'Recepción verificará su pago y le confirmará la cita por este chat.';

/** Dónde empieza la tabla de datos y cuánto mide cada fila. */
const Y_FILAS = 644;
const ALTO_FILA = 84;

const mayuscula = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** El pie de la imagen, y el mensaje entero cuando no hay imagen. */
export function textoConstancia(d: DatosConstancia): string {
  return [
    '🧾 *Constancia de su reserva*',
    '',
    `📅 ${mayuscula(fechaLarga(d.fecha))}, ${d.hora}`,
    `🩺 ${[d.medico, d.especialidad].filter(Boolean).join(' · ')}`,
    ...(d.montoBs ? [`💳 Pago enviado: ${textoBolivianos(d.montoBs)}`] : []),
    '',
    `_${ESTADO_CONSTANCIA}._ ${AVISO_CONSTANCIA}`,
  ].join('\n');
}

/** Una fila de la tabla: la etiqueta a la izquierda y el valor a la derecha, con una raya encima. */
function fila(y: number, etiqueta: string, valor: string, destacado = false): string {
  /* Lo que queda a la derecha de la etiqueta más larga («Especialidad»). */
  const v = ajustar(valor, 28, 22, 640);
  return [
    `<line x1="${MARGEN}" y1="${y}" x2="${ANCHO_IMAGEN - MARGEN}" y2="${y}" stroke="${COLOR.borde}" stroke-width="2"/>`,
    `<text x="${MARGEN}" y="${y + 53}" font-size="23" fill="${COLOR.apagado}">${escaparXml(etiqueta)}</text>`,
    `<text x="${ANCHO_IMAGEN - MARGEN}" y="${y + 53}" font-size="${v.tamano}"${destacado ? ' font-weight="600"' : ''} fill="${COLOR.texto}" text-anchor="end">${escaparXml(v.texto)}</text>`,
  ].join('');
}

/**
 * Una hoja blanca, como un comprobante impreso: el logo arriba, el estado en
 * una línea, el día y la hora, y los datos en filas. El verde queda en el logo,
 * el día y la hora; el ámbar, solo en el punto del estado.
 */
export function svgDeConstancia(d: DatosConstancia): string {
  const fecha = partesDeFecha(d.fecha);
  const derecha = ANCHO_IMAGEN - MARGEN;

  /* 1. De quién es y qué es. */
  const marca = [
    `<rect width="100%" height="8" fill="${COLOR.primario}"/>`,
    logo(MARGEN, 58, 56, COLOR.primario),
    `<text x="${MARGEN + 72}" y="97" font-size="28" font-weight="600" fill="${COLOR.texto}">${NOMBRE_CLINICA}</text>`,
    `<text x="${derecha}" y="95" font-size="19" fill="${COLOR.apagado}" text-anchor="end" letter-spacing="3">CONSTANCIA DE RESERVA</text>`,
    `<line x1="${MARGEN}" y1="156" x2="${derecha}" y2="156" stroke="${COLOR.borde}" stroke-width="2"/>`,
  ].join('');

  /* 2. El título y el estado: lo primero que tiene que entender. */
  const titulo = [
    `<text x="${MARGEN}" y="250" font-size="50" font-weight="600" fill="${COLOR.texto}">Su reserva está registrada</text>`,
    `<circle cx="${MARGEN + 8}" cy="305" r="8" fill="${COLOR.ambarBorde}"/>`,
    `<text x="${MARGEN + 30}" y="314" font-size="26" font-weight="600" fill="${COLOR.ambarTexto}">${escaparXml(ESTADO_CONSTANCIA)}</text>`,
    `<text x="${MARGEN}" y="356" font-size="22" fill="${COLOR.apagado}">${escaparXml(AVISO_CONSTANCIA)}</text>`,
  ].join('');

  /* 3. Cuándo: la hoja de calendario, en verde tenue, y la hora en grande. */
  const yCita = 420;
  const cita = [
    `<rect x="${MARGEN}" y="${yCita}" width="164" height="164" rx="22" fill="${COLOR.fondoSuave}"/>`,
    `<text x="${MARGEN + 82}" y="${yCita + 56}" font-size="24" font-weight="600" fill="${COLOR.primario}" text-anchor="middle" letter-spacing="3">${escaparXml((fecha?.mes ?? '').slice(0, 3).toUpperCase())}</text>`,
    `<text x="${MARGEN + 82}" y="${yCita + 130}" font-size="64" font-weight="600" fill="${COLOR.primario}" text-anchor="middle">${fecha?.dia ?? ''}</text>`,
    `<text x="${MARGEN + 204}" y="${yCita + 46}" font-size="20" fill="${COLOR.apagado}" letter-spacing="2">FECHA Y HORA DE LA CITA</text>`,
    `<text x="${MARGEN + 204}" y="${yCita + 94}" font-size="30" font-weight="600" fill="${COLOR.texto}">${escaparXml(mayuscula(fechaLarga(d.fecha)))}</text>`,
    `<text x="${MARGEN + 204}" y="${yCita + 156}" font-size="52" font-weight="600" fill="${COLOR.primario}">${escaparXml(d.hora)}</text>`,
  ].join('');

  /* 4. Con quién y por cuánto. Lo que no se sabe no ocupa una fila.
     Sin número de reserva: no le sirve a la paciente y confundía (16/10/2026). */
  const datos: [string, string, boolean?][] = [
    ['Paciente', d.paciente],
    ['Médico', d.medico],
    ...(d.especialidad ? [['Especialidad', d.especialidad] as [string, string]] : []),
    ...(d.montoBs ? [['Pago enviado', textoBolivianos(d.montoBs), true] as [string, string, boolean]] : []),
  ];
  const filas = datos.map(([etiqueta, valor, destacado], i) => fila(Y_FILAS + i * ALTO_FILA, etiqueta, valor, destacado)).join('');
  const yFin = Y_FILAS + datos.length * ALTO_FILA;

  /* 5. Dónde, y para qué sirve la imagen. */
  const alto = yFin + 170;
  const pie = [
    `<line x1="${MARGEN}" y1="${yFin}" x2="${derecha}" y2="${yFin}" stroke="${COLOR.borde}" stroke-width="2"/>`,
    `<text x="${MARGEN}" y="${yFin + 82}" font-size="24" font-weight="600" fill="${COLOR.texto}">${escaparXml(UBICACION_CLINICA.direccion)}</text>`,
    `<text x="${MARGEN}" y="${yFin + 120}" font-size="22" fill="${COLOR.apagado}">Guarde esta imagen como constancia de su reserva.</text>`,
  ].join('');

  return [abrirSvg(alto), marca, titulo, cita, filas, pie, '</svg>'].join('');
}
