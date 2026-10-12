/**
 * La mano común de las imágenes que manda la clínica por WhatsApp (el horario
 * de un médico, su agenda del día, la constancia de una reserva): colores,
 * logo, cabecera y pie. Puro: texto SVG que `ImagenHorarioService.dibujar`
 * convierte a PNG con la Poppins de `assets/fuentes`.
 *
 * Todas miden 1080 de ancho (lo que WhatsApp muestra nítido en un teléfono) y
 * comparten la cabecera verde con el logo, para que la paciente reconozca de un
 * vistazo que la imagen es de la clínica y no de cualquiera.
 *
 * Sin emojis ni símbolos fuera de la Poppins: resvg no tiene de dónde sacarlos y
 * saldrían como cuadros vacíos.
 */
import { NOMBRE_CLINICA } from './prompt-sistema';

export const ANCHO_IMAGEN = 1080;
/** El margen lateral de todo el contenido. */
export const MARGEN = 60;

/** Los del CRM (`--color-primary` y compañía) más los de estado. */
export const COLOR = {
  primario: '#006156',
  primarioOscuro: '#004A42',
  secundario: '#39ADA3',
  fondoSuave: '#EAF7F5',
  texto: '#1F2937',
  apagado: '#6B7280',
  borde: '#E5E7EB',
  fondoGris: '#F3F4F6',
  ambarFondo: '#FEF3C7',
  ambarTexto: '#92400E',
  ambarBorde: '#F59E0B',
  azulFondo: '#DBEAFE',
  azulTexto: '#1E40AF',
  azulBorde: '#60A5FA',
} as const;

export function escaparXml(texto: string): string {
  return texto.replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
}

/** Un texto largo baja de tamaño en vez de salirse; muy largo, se corta. */
export function ajustar(texto: string, maximo: number, minimo: number, ancho: number): { texto: string; tamano: number } {
  /* Poppins semibold mide ~0,6 em por carácter en promedio. */
  const tamano = Math.max(minimo, Math.min(maximo, Math.floor(ancho / (Math.max(1, texto.length) * 0.6))));
  const caben = Math.floor(ancho / (tamano * 0.6));
  return { texto: texto.length > caben ? `${texto.slice(0, caben - 1).trimEnd()}…` : texto, tamano };
}

export const horaDeMinutos = (minutos: number) =>
  `${String(Math.floor(minutos / 60)).padStart(2, '0')}:${String(minutos % 60).padStart(2, '0')}`;

/** El logo de la clínica (el de `favicon.svg` del CRM), en un cuadrado de `tamano` con esquina en (x, y). */
export function logo(x: number, y: number, tamano: number, color: string): string {
  return [
    `<g transform="translate(${x} ${y}) scale(${(tamano / 1080).toFixed(4)})" fill="${color}">`,
    '<path d="M46.9,532.8c0-282.3,228.9-511.2,511.3-511.2c178.8,0,336.2,91.8,427.5,230.8C901.6,143.3,769.7,73,621.3,73c-253.9,0-459.8,205.8-459.8,459.7c0,253.9,205.8,459.7,459.8,459.7c148.4,0,280.3-70.2,364.4-179.3c-91.4,139-248.7,230.8-427.5,230.8C275.8,1044,46.9,815.1,46.9,532.8z"/>',
    '<path d="M236.4,567.6c0-200.3,162.4-362.6,362.7-362.6c126.8,0,238.5,65.1,303.3,163.7c-59.6-77.4-153.2-127.2-258.5-127.2c-180.1,0-326.1,146-326.1,326.1s146,326.1,326.1,326.1c105.2,0,198.8-49.8,258.5-127.2c-64.8,98.6-176.4,163.7-303.3,163.7C398.8,930.2,236.4,767.9,236.4,567.6z"/>',
    '<path d="M803.5,498c15.6-22.9,41.9-38,71.7-38c47.8,0,86.6,38.8,86.6,86.6c0,47.8-38.8,86.6-86.6,86.6c-1.4,0-2.7,0-4.1-0.1c33.3-8.6,57.9-38.8,57.9-74.8c0-42.6-34.6-77.2-77.2-77.2C833.5,481,816.7,487.4,803.5,498z"/>',
    '<path fill-rule="evenodd" d="M442.3,770.7c0,0,37.3-285.7,360.3-223.6C805.1,547.5,541.7,564.4,442.3,770.7z"/>',
    '</g>',
  ].join('');
}

/** El comienzo del documento: tamaño, letra y fondo blanco. */
export function abrirSvg(alto: number): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${ANCHO_IMAGEN}" height="${alto}" viewBox="0 0 ${ANCHO_IMAGEN} ${alto}" font-family="Poppins">`,
    `<rect width="100%" height="100%" fill="#FFFFFF"/>`,
  ].join('');
}

export const ALTO_MARCA = 132;

/**
 * La franja verde de arriba: el logo con el nombre de la clínica, y el logo
 * grande y tenue a la derecha como marca de agua. Lo de debajo de `ALTO_MARCA`
 * (el título de cada imagen) lo dibuja cada una sobre el mismo verde.
 */
export function cabecera(alto: number): string {
  return [
    `<rect width="100%" height="${alto}" fill="${COLOR.primario}"/>`,
    /* La marca de agua se recorta con la franja: que no invada el contenido. */
    `<clipPath id="franja"><rect width="${ANCHO_IMAGEN}" height="${alto}"/></clipPath>`,
    `<g clip-path="url(#franja)" opacity="0.07">${logo(ANCHO_IMAGEN - 330, alto - 300, 420, '#FFFFFF')}</g>`,
    logo(MARGEN, 46, 60, '#FFFFFF'),
    `<text x="${MARGEN + 76}" y="88" font-size="30" font-weight="600" fill="#FFFFFF">${NOMBRE_CLINICA}</text>`,
    `<line x1="${MARGEN}" y1="${ALTO_MARCA}" x2="${ANCHO_IMAGEN - MARGEN}" y2="${ALTO_MARCA}" stroke="#FFFFFF" stroke-opacity="0.18" stroke-width="2"/>`,
  ].join('');
}

/** La etiqueta pequeña en mayúsculas sobre el título («HORARIO DE ATENCIÓN»). */
export function antetitulo(texto: string, y: number): string {
  return `<text x="${MARGEN}" y="${y}" font-size="24" fill="#FFFFFF" fill-opacity="0.8" letter-spacing="3">${escaparXml(texto.toUpperCase())}</text>`;
}

/** La franja de abajo: una línea fuerte y una de apoyo. */
export function pie(alto: number, altoPie: number, principal: string, apoyo: string): string {
  const y = alto - altoPie;
  return [
    `<rect y="${y}" width="100%" height="${altoPie}" fill="${COLOR.fondoSuave}"/>`,
    `<text x="${MARGEN}" y="${y + altoPie / 2 - 6}" font-size="28" font-weight="600" fill="${COLOR.primario}">${escaparXml(principal)}</text>`,
    `<text x="${MARGEN}" y="${y + altoPie / 2 + 32}" font-size="23" fill="${COLOR.apagado}">${escaparXml(apoyo)}</text>`,
  ].join('');
}

/** Una pastilla redondeada con su texto centrado. */
export function pastilla(
  x: number, y: number, ancho: number, alto: number, texto: string,
  c: { fondo: string; texto: string; borde: string }, tamano = 24,
): string {
  return [
    `<rect x="${x}" y="${y}" width="${ancho}" height="${alto}" rx="${alto / 2}" fill="${c.fondo}" stroke="${c.borde}" stroke-width="2"/>`,
    `<text x="${x + ancho / 2}" y="${y + alto / 2 + tamano * 0.36}" font-size="${tamano}" font-weight="600" fill="${c.texto}" text-anchor="middle">${escaparXml(texto)}</text>`,
  ].join('');
}

/** Un título de sección: mayúsculas grises con una raya hasta el borde. */
export function tituloSeccion(texto: string, y: number, derecha?: string): string {
  return [
    `<text x="${MARGEN}" y="${y}" font-size="22" font-weight="600" fill="${COLOR.apagado}" letter-spacing="2">${escaparXml(texto.toUpperCase())}</text>`,
    derecha ? `<text x="${ANCHO_IMAGEN - MARGEN}" y="${y}" font-size="22" fill="${COLOR.apagado}" text-anchor="end">${escaparXml(derecha)}</text>` : '',
  ].join('');
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/** Las partes de una fecha civil AAAA-MM-DD, sin pasar por una zona horaria. `null` si no es una fecha. */
export function partesDeFecha(fecha: string): { diaSemana: string; dia: number; mes: string; anio: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return { diaSemana: DIAS[d.getUTCDay()], dia: d.getUTCDate(), mes: MESES[d.getUTCMonth()], anio: d.getUTCFullYear() };
}

/** «sábado 11 de octubre de 2026», de un AAAA-MM-DD. */
export function fechaLarga(fecha: string): string {
  const p = partesDeFecha(fecha);
  return p ? `${p.diaSemana} ${p.dia} de ${p.mes} de ${p.anio}` : fecha;
}

/** Una foto lista para ir dentro del SVG. Solo JPEG y PNG: los que el motor dibuja. */
export interface FotoEmbebida {
  readonly mime: 'image/jpeg' | 'image/png';
  readonly base64: string;
}

/** «Dra. Claudia Azogue» → «CA»: sin el título, dos letras. */
export function iniciales(nombre: string): string {
  const palabras = nombre.replace(/^(dra?|lic|mgr|msc|phd)\.?\s+/i, '').split(/\s+/).filter(p => /^\p{L}/u.test(p));
  return palabras.slice(0, 2).map(p => p.charAt(0).toUpperCase()).join('') || '+';
}

/**
 * El retrato redondo de una persona, con un aro blanco. Debajo de la foto van
 * sus iniciales: si el motor no puede leer la imagen (un JPEG en CMYK), no
 * queda un hueco, quedan las iniciales.
 */
export function retrato(cx: number, cy: number, radio: number, foto: FotoEmbebida, nombre: string): string {
  return [
    `<circle cx="${cx}" cy="${cy}" r="${radio + 6}" fill="#FFFFFF"/>`,
    `<circle cx="${cx}" cy="${cy}" r="${radio}" fill="${COLOR.primarioOscuro}"/>`,
    `<text x="${cx}" y="${cy + radio * 0.22}" font-size="${Math.round(radio * 0.62)}" font-weight="600" fill="#FFFFFF" text-anchor="middle">${escaparXml(iniciales(nombre))}</text>`,
    `<clipPath id="retrato"><circle cx="${cx}" cy="${cy}" r="${radio}"/></clipPath>`,
    `<image x="${cx - radio}" y="${cy - radio}" width="${radio * 2}" height="${radio * 2}" preserveAspectRatio="xMidYMin slice" clip-path="url(#retrato)" href="data:${foto.mime};base64,${foto.base64}"/>`,
  ].join('');
}
