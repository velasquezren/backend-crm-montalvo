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
import {
  abrirSvg, ajustar, ALTO_MARCA, ANCHO_IMAGEN, antetitulo, cabecera, COLOR, escaparXml, fechaLarga, MARGEN, partesDeFecha, pie,
} from '../asistente/marca-imagen';
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

/** El diseño de la imagen: sube cuando cambia el dibujo, para no reusar un PNG viejo. */
export const VERSION_DISENO_CONSTANCIA = 1;

export const ESTADO_CONSTANCIA = 'Pago recibido: en verificación';
const AVISO_CONSTANCIA = 'Recepción verificará su pago y le confirmará la cita por este chat.';

const CABECERA = 360;
const ALTO = 1170;
const PIE = 140;

const mayuscula = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** El pie de la imagen, y el mensaje entero cuando no hay imagen. */
export function textoConstancia(d: DatosConstancia): string {
  return [
    `🧾 *Constancia de su reserva N.º ${d.reserva}*`,
    '',
    `📅 ${mayuscula(fechaLarga(d.fecha))}, ${d.hora}`,
    `🩺 ${[d.medico, d.especialidad].filter(Boolean).join(' · ')}`,
    ...(d.montoBs ? [`💳 Pago enviado: ${textoBolivianos(d.montoBs)}`] : []),
    '',
    `_${ESTADO_CONSTANCIA}._ ${AVISO_CONSTANCIA}`,
  ].join('\n');
}

/** Un dato con su etiqueta encima, en media columna. */
function dato(x: number, y: number, etiqueta: string, valor: string): string {
  const v = ajustar(valor, 28, 24, 430);
  return [
    `<text x="${x}" y="${y}" font-size="21" font-weight="600" fill="${COLOR.apagado}" letter-spacing="2">${escaparXml(etiqueta.toUpperCase())}</text>`,
    `<text x="${x}" y="${y + 44}" font-size="${v.tamano}" fill="${COLOR.texto}">${escaparXml(v.texto)}</text>`,
  ].join('');
}

/** El reloj del aviso de estado, dibujado: la Poppins no trae íconos. */
const reloj = (cx: number, cy: number) => [
  `<circle cx="${cx}" cy="${cy}" r="26" fill="none" stroke="${COLOR.ambarTexto}" stroke-width="4"/>`,
  `<path d="M${cx} ${cy - 14} V${cy} L${cx + 11} ${cy + 8}" fill="none" stroke="${COLOR.ambarTexto}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`,
].join('');

export function svgDeConstancia(d: DatosConstancia): string {
  const fecha = partesDeFecha(d.fecha);
  const derecha = ANCHO_IMAGEN - MARGEN;

  /* 1. El estado, en ámbar: es lo primero que tiene que entender. */
  const yEstado = CABECERA + 36;
  const estado = [
    `<rect x="${MARGEN}" y="${yEstado}" width="${derecha - MARGEN}" height="112" rx="20" fill="${COLOR.ambarFondo}" stroke="${COLOR.ambarBorde}" stroke-width="2"/>`,
    reloj(MARGEN + 56, yEstado + 56),
    `<text x="${MARGEN + 108}" y="${yEstado + 48}" font-size="28" font-weight="600" fill="${COLOR.ambarTexto}">${escaparXml(ESTADO_CONSTANCIA)}</text>`,
    `<text x="${MARGEN + 108}" y="${yEstado + 84}" font-size="22" fill="${COLOR.ambarTexto}">${escaparXml(AVISO_CONSTANCIA)}</text>`,
  ].join('');

  /* 2. Cuándo: la hoja de calendario y la hora en grande. */
  const yCita = yEstado + 148;
  const cita = [
    `<rect x="${MARGEN}" y="${yCita}" width="${derecha - MARGEN}" height="210" rx="24" fill="#FFFFFF" stroke="${COLOR.borde}" stroke-width="2"/>`,
    `<rect x="${MARGEN + 28}" y="${yCita + 25}" width="160" height="160" rx="20" fill="${COLOR.primario}"/>`,
    `<path d="M${MARGEN + 28} ${yCita + 89} H${MARGEN + 188}" stroke="#FFFFFF" stroke-opacity="0.25" stroke-width="2"/>`,
    `<text x="${MARGEN + 108}" y="${yCita + 72}" font-size="26" font-weight="600" fill="#FFFFFF" text-anchor="middle" letter-spacing="3">${escaparXml((fecha?.mes ?? '').slice(0, 3).toUpperCase())}</text>`,
    `<text x="${MARGEN + 108}" y="${yCita + 160}" font-size="64" font-weight="600" fill="#FFFFFF" text-anchor="middle">${fecha?.dia ?? ''}</text>`,
    `<text x="${MARGEN + 224}" y="${yCita + 78}" font-size="30" font-weight="600" fill="${COLOR.texto}">${escaparXml(mayuscula(fechaLarga(d.fecha)))}</text>`,
    `<text x="${MARGEN + 224}" y="${yCita + 120}" font-size="22" fill="${COLOR.apagado}" letter-spacing="2">HORA DE LA CITA</text>`,
    `<text x="${MARGEN + 224}" y="${yCita + 182}" font-size="60" font-weight="600" fill="${COLOR.primario}">${escaparXml(d.hora)}</text>`,
  ].join('');

  /* 3. Con quién y por cuánto, en dos columnas. */
  const yDatos = yCita + 270;
  const columna2 = MARGEN + 480;
  const datos = [
    dato(MARGEN, yDatos, 'Paciente', d.paciente),
    dato(columna2, yDatos, 'Médico', d.medico),
    dato(MARGEN, yDatos + 120, 'Especialidad', d.especialidad ?? '—'),
    dato(columna2, yDatos + 120, 'Pago enviado', d.montoBs ? textoBolivianos(d.montoBs) : '—'),
    `<line x1="${MARGEN}" y1="${yDatos + 78}" x2="${derecha}" y2="${yDatos + 78}" stroke="${COLOR.borde}" stroke-width="2"/>`,
  ].join('');

  return [
    abrirSvg(ALTO),
    cabecera(CABECERA),
    antetitulo('Constancia de reserva', ALTO_MARCA + 62),
    `<text x="${MARGEN}" y="${ALTO_MARCA + 128}" font-size="52" font-weight="600" fill="#FFFFFF">Su reserva está registrada</text>`,
    `<text x="${MARGEN}" y="${ALTO_MARCA + 180}" font-size="30" fill="#FFFFFF" fill-opacity="0.9">Reserva N.º ${d.reserva}</text>`,
    estado,
    cita,
    datos,
    pie(ALTO, PIE, UBICACION_CLINICA.direccion, 'Guarde esta imagen: tiene el número de su reserva.'),
    '</svg>',
  ].join('');
}
