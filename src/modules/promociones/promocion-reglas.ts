import { randomInt } from 'node:crypto';

import { EstadoPromocion, FormatoBanner } from '../../prisma/prisma-client';

/*
 * Las reglas de una promoción, puras: ciclo de vida, formatos de banner,
 * vigencia y qué hace falta para publicarla. Las usan el service, la API
 * pública y sus pruebas sin base de datos. Diseño: docs/promociones-y-directorio.md.
 */

/* ── Ciclo de vida ─────────────────────────────────────────────────────── */

/** Las transiciones y quién puede pedirlas. Lo que no está aquí, no existe. */
export const TRANSICIONES = {
  /** La agente la manda a revisar. */
  enviar: { desde: ['BORRADOR'], hacia: 'EN_REVISION', rango: 'AGENTE' },
  /** Un admin la devuelve con un motivo. */
  devolver: { desde: ['EN_REVISION'], hacia: 'BORRADOR', rango: 'ADMIN' },
  /** Un admin la publica (también un borrador suyo, sin pasar por revisión). */
  publicar: { desde: ['BORRADOR', 'EN_REVISION', 'PAUSADA'], hacia: 'PUBLICADA', rango: 'ADMIN' },
  pausar: { desde: ['PUBLICADA'], hacia: 'PAUSADA', rango: 'ADMIN' },
  /** Terminal: lo archivado no vuelve. Para repetir una promoción, se crea otra. */
  archivar: { desde: ['BORRADOR', 'EN_REVISION', 'PUBLICADA', 'PAUSADA'], hacia: 'ARCHIVADA', rango: 'ADMIN' },
} as const satisfies Record<string, { desde: readonly EstadoPromocion[]; hacia: EstadoPromocion; rango: 'AGENTE' | 'ADMIN' }>;

export type AccionPromocion = keyof typeof TRANSICIONES;
export const ACCIONES_PROMOCION = Object.keys(TRANSICIONES) as AccionPromocion[];

/**
 * ¿Puede editar el contenido? Una agente, solo un borrador: lo que está en
 * revisión o publicado lo ve un admin o un paciente, y no puede cambiar por
 * debajo. Un admin edita todo salvo lo archivado (y su cambio en una publicada
 * se ve al instante: es quien la aprueba).
 */
export function puedeEditar(estado: EstadoPromocion, esAdmin: boolean): boolean {
  if (estado === 'ARCHIVADA') return false;
  return esAdmin || estado === 'BORRADOR';
}

/* ── Banners ───────────────────────────────────────────────────────────── */

/**
 * Cada formato, por qué existe y lo mínimo que tiene que medir. Las medidas
 * son las recomendadas por Meta para cada ubicación; la proporción se acepta
 * con un 2 % de holgura (una exportación de 1080×1351 no es un error).
 */
export const FORMATOS_BANNER: Record<FormatoBanner, { proporcion: number; anchoMinimo: number; altoMinimo: number; uso: string; nombre: string }> = {
  CUADRADO: { proporcion: 1, anchoMinimo: 1080, altoMinimo: 1080, nombre: 'Cuadrado 1:1', uso: 'WhatsApp, tarjetas de la landing y feed de Instagram/Facebook. Obligatorio.' },
  VERTICAL: { proporcion: 4 / 5, anchoMinimo: 1080, altoMinimo: 1350, nombre: 'Vertical 4:5', uso: 'Feed de Instagram y Facebook en el teléfono.' },
  HISTORIA: { proporcion: 9 / 16, anchoMinimo: 1080, altoMinimo: 1920, nombre: 'Historia 9:16', uso: 'Historias y Reels.' },
  HORIZONTAL: { proporcion: 1.91, anchoMinimo: 1200, altoMinimo: 628, nombre: 'Horizontal 1,91:1', uso: 'Cabecera de la promoción en la landing y enlaces compartidos.' },
};

export const FORMATO_OBLIGATORIO: FormatoBanner = 'CUADRADO';
const HOLGURA_PROPORCION = 0.02;

/** Por qué una imagen no sirve para ese formato; `null` si sirve. */
export function problemaDeBanner(formato: FormatoBanner, ancho: number, alto: number): string | null {
  const f = FORMATOS_BANNER[formato];
  const proporcion = ancho / alto;
  if (Math.abs(proporcion - f.proporcion) / f.proporcion > HOLGURA_PROPORCION) {
    return `El formato ${f.nombre} necesita esa proporción; la imagen mide ${ancho}×${alto}.`;
  }
  if (ancho < f.anchoMinimo || alto < f.altoMinimo) {
    return `El formato ${f.nombre} necesita al menos ${f.anchoMinimo}×${f.altoMinimo} px; la imagen mide ${ancho}×${alto}.`;
  }
  return null;
}

/* ── Vigencia ──────────────────────────────────────────────────────────── */

export type Vigencia = 'PROXIMA' | 'VIGENTE' | 'VENCIDA';

/** Fechas civiles (`@db.Date`, medianoche UTC) contra el día de hoy en La Paz. */
export function vigenciaDe(desde: Date, hasta: Date | null, hoy: Date): Vigencia {
  if (hoy < desde) return 'PROXIMA';
  if (hasta && hoy > hasta) return 'VENCIDA';
  return 'VIGENTE';
}

/* ── Publicar ──────────────────────────────────────────────────────────── */

export interface PromocionParaPublicar {
  titulo: string;
  resumen: string;
  condiciones: string;
  etiquetaOferta: string | null;
  precioRegular: number | null;
  precioPromocional: number | null;
  vigenteDesde: Date;
  vigenteHasta: Date | null;
  enLanding: boolean;
  enWhatsapp: boolean;
  formatos: readonly FormatoBanner[];
}

/**
 * Lo que falta para que una promoción se pueda mostrar a pacientes. Vacío =
 * lista. Se exige al mandarla a revisión Y al publicarla: un admin no aprueba
 * algo incompleto, y una pausada que venció no se vuelve a publicar.
 */
export function faltantesParaPublicar(p: PromocionParaPublicar, hoy: Date): string[] {
  const faltan: string[] = [];
  if (!p.titulo.trim()) faltan.push('Falta el título.');
  if (!p.resumen.trim()) faltan.push('Falta el resumen.');
  if (!p.formatos.includes(FORMATO_OBLIGATORIO)) faltan.push(`Falta el banner ${FORMATOS_BANNER[FORMATO_OBLIGATORIO].nombre}.`);
  const tieneOferta = p.precioRegular !== null || p.precioPromocional !== null || !!p.etiquetaOferta;
  if (tieneOferta && !p.condiciones.trim()) faltan.push('Con precio u oferta hacen falta las condiciones (qué incluye, hasta cuándo).');
  if (p.precioRegular !== null && p.precioPromocional !== null && p.precioPromocional >= p.precioRegular) {
    faltan.push('El precio promocional tiene que ser menor que el regular.');
  }
  if (p.vigenteHasta && p.vigenteHasta < p.vigenteDesde) faltan.push('La vigencia termina antes de empezar.');
  if (p.vigenteHasta && p.vigenteHasta < hoy) faltan.push('La vigencia ya terminó.');
  if (!p.enLanding && !p.enWhatsapp) faltan.push('Elige al menos un canal: la landing o WhatsApp.');
  return faltan;
}

/* ── Código ────────────────────────────────────────────────────────────── */

/** Sin 0/O ni 1/I/L: el código se dicta por teléfono y se lee en un chat. */
const ALFABETO = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** «PRM-7K3QX»: identifica la promoción en el mensaje con que llega la paciente. */
export function generarCodigo(): string {
  let codigo = 'PRM-';
  for (let i = 0; i < 5; i++) codigo += ALFABETO[randomInt(ALFABETO.length)];
  return codigo;
}

/** El mensaje que la landing pone en el enlace de WhatsApp: legible para la paciente, con el código al final. */
export function mensajeDeWhatsapp(titulo: string, codigo: string): string {
  return `Hola, me interesa la promoción «${titulo}» (${codigo}).`;
}
