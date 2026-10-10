/**
 * La imagen del horario semanal de un médico, como SVG. Puro y probado: el
 * dibujo es texto, y la conversión a PNG (`imagen-horario.service.ts`) no
 * decide nada.
 *
 * Por qué una imagen y no la frase «Martes: entre 10:00 y 12:00»: en WhatsApp
 * una tabla escrita se desarma, y la paciente la guarda o la reenvía. La frase
 * sigue yendo como pie de la imagen: se copia y la lee un lector de pantalla.
 *
 * Los colores son los del CRM (`--color-primary` y compañía); la letra, la
 * Poppins que está en `assets/fuentes` con su licencia (OFL).
 */

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
}

const DIAS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'] as const;

const COLOR = {
  primario: '#006156',
  secundario: '#39ADA3',
  fondoSuave: '#EAF7F5',
  texto: '#1F2937',
  apagado: '#6B7280',
  borde: '#E5E7EB',
} as const;

export const ANCHO_HORARIO = 1080;
const CABECERA = 290;
const FILA = 116;
const PIE = 110;

export function escaparXml(texto: string): string {
  return texto.replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
}

const hora = (minutos: number) => `${String(Math.floor(minutos / 60)).padStart(2, '0')}:${String(minutos % 60).padStart(2, '0')}`;

/** Un nombre largo baja de tamaño en vez de salirse; muy largo, se corta. */
function ajustar(texto: string, maximo: number, minimo: number, ancho: number): { texto: string; tamano: number } {
  /* Poppins semibold mide ~0,6 em por carácter en promedio. */
  const tamano = Math.max(minimo, Math.min(maximo, Math.floor(ancho / (texto.length * 0.6))));
  const caben = Math.floor(ancho / (tamano * 0.6));
  return { texto: texto.length > caben ? `${texto.slice(0, caben - 1).trimEnd()}…` : texto, tamano };
}

export function svgDelHorario(d: DatosHorario): string {
  const alto = CABECERA + FILA * DIAS.length + PIE;
  const nombre = ajustar(d.medico, 60, 36, ANCHO_HORARIO - 120);
  const filas = DIAS.map((dia, i) => {
    const y = CABECERA + i * FILA;
    const bloques = d.bloques.filter(b => b.diaSemana === i + 1).sort((a, b) => a.inicioMinuto - b.inicioMinuto).slice(0, 3);
    const atiende = bloques.length > 0;
    const pastillas = bloques.map((b, j) => {
      const x = 360 + j * 236;
      return [
        `<rect x="${x}" y="${y + 30}" width="220" height="56" rx="28" fill="${COLOR.fondoSuave}" stroke="${COLOR.secundario}" stroke-width="2"/>`,
        `<text x="${x + 110}" y="${y + 67}" font-size="28" font-weight="600" fill="${COLOR.primario}" text-anchor="middle">${hora(b.inicioMinuto)} – ${hora(b.finMinuto)}</text>`,
      ].join('');
    }).join('');
    return [
      i > 0 ? `<line x1="60" y1="${y}" x2="${ANCHO_HORARIO - 60}" y2="${y}" stroke="${COLOR.borde}" stroke-width="2"/>` : '',
      `<text x="60" y="${y + 70}" font-size="34" font-weight="600" fill="${atiende ? COLOR.texto : COLOR.apagado}">${dia}</text>`,
      atiende ? pastillas : `<text x="360" y="${y + 68}" font-size="28" fill="${COLOR.apagado}">No atiende</text>`,
    ].join('');
  }).join('');

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${ANCHO_HORARIO}" height="${alto}" viewBox="0 0 ${ANCHO_HORARIO} ${alto}" font-family="Poppins">`,
    `<rect width="100%" height="100%" fill="#FFFFFF"/>`,
    `<rect width="100%" height="${CABECERA - 24}" fill="${COLOR.primario}"/>`,
    `<text x="60" y="80" font-size="28" fill="#FFFFFF" fill-opacity="0.85" letter-spacing="3">HORARIO DE ATENCIÓN</text>`,
    /* La línea base del nombre baja con su tamaño; la especialidad va debajo con aire para los descendentes. */
    `<text x="60" y="${172 - (60 - nombre.tamano) / 2}" font-size="${nombre.tamano}" font-weight="600" fill="#FFFFFF">${escaparXml(nombre.texto)}</text>`,
    d.especialidad ? `<text x="60" y="226" font-size="30" fill="#FFFFFF" fill-opacity="0.85">${escaparXml(ajustar(d.especialidad, 30, 24, ANCHO_HORARIO - 120).texto)}</text>` : '',
    filas,
    `<rect y="${alto - PIE}" width="100%" height="${PIE}" fill="${COLOR.fondoSuave}"/>`,
    `<text x="60" y="${alto - PIE + 50}" font-size="30" font-weight="600" fill="${COLOR.primario}">Clínica Montalvo</text>`,
    `<text x="60" y="${alto - PIE + 86}" font-size="24" fill="${COLOR.apagado}">Horario de referencia: los cupos se confirman por este chat.</text>`,
    '</svg>',
  ].join('');
}

/** La versión del dibujo: cambia con los datos o con el diseño, y nada más. */
export const VERSION_DISENO_HORARIO = 1;
