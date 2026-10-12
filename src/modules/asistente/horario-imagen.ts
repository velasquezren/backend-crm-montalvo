/**
 * La imagen del horario semanal de un médico, como SVG. Puro y probado: el
 * dibujo es texto, y la conversión a PNG (`imagen-horario.service.ts`) no
 * decide nada.
 *
 * Por qué una imagen y no la frase «Martes: entre 10:00 y 12:00»: en WhatsApp
 * una tabla escrita se desarma, y la paciente la guarda o la reenvía. La frase
 * sigue yendo como pie de la imagen: se copia y la lee un lector de pantalla.
 *
 * Se lee como la pregunta que se hace la paciente («¿me atiende el jueves por la
 * tarde?»): una fila por día y dos columnas, mañana y tarde. Un turno va a la
 * columna de la hora en que EMPIEZA. Los días sin atención ocupan menos alto, para
 * que el ojo vaya a los que sí. Mano común (logo, colores, cabecera) en
 * `marca-imagen.ts`.
 */
import {
  abrirSvg, ajustar, ALTO_MARCA, ANCHO_IMAGEN, antetitulo, cabecera, COLOR, escaparXml, FotoEmbebida, horaDeMinutos, MARGEN, pastilla, pie, retrato,
} from './marca-imagen';

export interface BloqueDia {
  /** 1 = lunes … 6 = sábado (la agenda no abre domingos). */
  readonly diaSemana: number;
  readonly inicioMinuto: number;
  readonly finMinuto: number;
}

export interface DatosHorario {
  readonly medico: string;
  readonly especialidad: string | null;
  readonly bloques: readonly BloqueDia[];
  /** El precio de la consulta en la agenda, en bolivianos; sin él no se muestra. */
  readonly precioBs?: number | null;
  /** Su foto (la de la landing): la paciente reconoce a quién va a ver. Sin ella, la cabecera es solo texto. */
  readonly foto?: FotoEmbebida | null;
}

const DIAS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'] as const;

export const ANCHO_HORARIO = ANCHO_IMAGEN;
/** Desde esta hora, un turno es «de la tarde». */
export const INICIO_TARDE_MINUTO = 13 * 60;
/** Más turnos que estos en media jornada no caben en la celda (y no existen en la agenda). */
const TURNOS_POR_CELDA = 3;

const CABECERA = 350;
const ENCABEZADO_TABLA = 76;
const FILA_CERRADA = 76;
const TURNO = 66;
const PIE = 140;
const COLUMNA_MANANA = 330;
const COLUMNA_TARDE = 690;
const ANCHO_PASTILLA = 300;
const RADIO_FOTO = 88;

const ESTILO_TURNO = { fondo: COLOR.fondoSuave, texto: COLOR.primario, borde: COLOR.secundario };

/** «Bs 150» o «Bs 150,50». */
export function textoBolivianos(bs: number): string {
  return `Bs ${bs.toLocaleString('es-BO', { minimumFractionDigits: Number.isInteger(bs) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

interface FilaDia {
  readonly dia: string;
  readonly manana: readonly BloqueDia[];
  readonly tarde: readonly BloqueDia[];
}

function filasDeLaSemana(bloques: readonly BloqueDia[]): FilaDia[] {
  return DIAS.map((dia, i) => {
    const delDia = bloques.filter(b => b.diaSemana === i + 1).sort((a, b) => a.inicioMinuto - b.inicioMinuto);
    return {
      dia,
      manana: delDia.filter(b => b.inicioMinuto < INICIO_TARDE_MINUTO).slice(0, TURNOS_POR_CELDA),
      tarde: delDia.filter(b => b.inicioMinuto >= INICIO_TARDE_MINUTO).slice(0, TURNOS_POR_CELDA),
    };
  });
}

const altoDeFila = (f: FilaDia) => {
  const turnos = Math.max(f.manana.length, f.tarde.length);
  return turnos === 0 ? FILA_CERRADA : 32 + turnos * TURNO;
};

function celda(x: number, y: number, turnos: readonly BloqueDia[]): string {
  if (turnos.length === 0) return `<text x="${x + ANCHO_PASTILLA / 2}" y="${y + 58}" font-size="28" fill="${COLOR.apagado}" fill-opacity="0.5" text-anchor="middle">—</text>`;
  return turnos.map((b, j) =>
    pastilla(x, y + 22 + j * TURNO, ANCHO_PASTILLA, 54, `${horaDeMinutos(b.inicioMinuto)} – ${horaDeMinutos(b.finMinuto)}`, ESTILO_TURNO, 27),
  ).join('');
}

export function svgDelHorario(d: DatosHorario): string {
  const filas = filasDeLaSemana(d.bloques);
  const inicioTabla = CABECERA + ENCABEZADO_TABLA;
  const alto = inicioTabla + filas.reduce((s, f) => s + altoDeFila(f), 0) + 24 + PIE;
  /* Con foto, el texto de la cabecera termina antes del retrato. */
  const anchoTexto = ANCHO_IMAGEN - 2 * MARGEN - (d.foto ? 2 * RADIO_FOTO + 40 : 0);
  const nombre = ajustar(d.medico, 56, 34, anchoTexto);
  const subtitulo = [d.especialidad, d.precioBs ? `Consulta ${textoBolivianos(d.precioBs)}` : null].filter(Boolean).join('  ·  ');

  let y = inicioTabla;
  const cuerpo = filas.map((f, i) => {
    const alta = altoDeFila(f);
    const atiende = alta !== FILA_CERRADA;
    const fila = [
      i > 0 ? `<line x1="${MARGEN}" y1="${y}" x2="${ANCHO_IMAGEN - MARGEN}" y2="${y}" stroke="${COLOR.borde}" stroke-width="2"/>` : '',
      `<text x="${MARGEN}" y="${y + (atiende ? 60 : 50)}" font-size="${atiende ? 32 : 28}" font-weight="600" fill="${atiende ? COLOR.texto : COLOR.apagado}">${f.dia}</text>`,
      atiende
        ? celda(COLUMNA_MANANA, y, f.manana) + celda(COLUMNA_TARDE, y, f.tarde)
        : `<text x="${COLUMNA_MANANA + 4}" y="${y + 49}" font-size="26" fill="${COLOR.apagado}">No atiende</text>`,
    ].join('');
    y += alta;
    return fila;
  }).join('');

  return [
    abrirSvg(alto),
    cabecera(CABECERA),
    antetitulo('Horario de atención', ALTO_MARCA + 62),
    /* La línea base del nombre baja con su tamaño: el antetítulo y la especialidad no se tocan. */
    `<text x="${MARGEN}" y="${ALTO_MARCA + 128 - (56 - nombre.tamano) / 2}" font-size="${nombre.tamano}" font-weight="600" fill="#FFFFFF">${escaparXml(nombre.texto)}</text>`,
    subtitulo
      ? `<text x="${MARGEN}" y="${ALTO_MARCA + 180}" font-size="28" fill="#FFFFFF" fill-opacity="0.88">${escaparXml(ajustar(subtitulo, 28, 22, anchoTexto).texto)}</text>`
      : '',
    d.foto ? retrato(ANCHO_IMAGEN - MARGEN - RADIO_FOTO, (ALTO_MARCA + CABECERA) / 2, RADIO_FOTO, d.foto, d.medico) : '',
    `<rect y="${CABECERA}" width="100%" height="${ENCABEZADO_TABLA}" fill="${COLOR.fondoGris}"/>`,
    ...[['Día', MARGEN], ['Mañana', COLUMNA_MANANA + 4], ['Tarde', COLUMNA_TARDE + 4]].map(([t, x]) =>
      `<text x="${x}" y="${CABECERA + 48}" font-size="22" font-weight="600" fill="${COLOR.apagado}" letter-spacing="2">${String(t).toUpperCase()}</text>`),
    cuerpo,
    pie(alto, PIE, 'Reserva tu cita por este chat', 'Horario de referencia: el cupo se confirma al reservar.'),
    '</svg>',
  ].join('');
}

/** La versión del dibujo: cambia con los datos o con el diseño, y nada más. */
export const VERSION_DISENO_HORARIO = 3;
