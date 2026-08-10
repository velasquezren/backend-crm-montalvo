/**
 * ¿Está la clínica atendiendo en este momento?
 *
 * Todo aquí es función pura y sin dependencias: recibe la fecha y la
 * configuración, devuelve un booleano. Así se puede probar el borde de las 18:00
 * un sábado sin levantar Nest ni Postgres, que es donde de verdad se equivoca
 * uno.
 */

/** Tramo de un día concreto, en minutos desde medianoche. */
interface Tramo {
  dia: number; // 1 = lunes … 7 = domingo (ISO)
  desde: number;
  hasta: number;
}

export interface HorarioAtencion {
  tramos: readonly Tramo[];
  zona: string;
}

/** Zona por defecto: la clínica está en Bolivia, el servidor no. */
export const ZONA_POR_DEFECTO = 'America/La_Paz';

const DIAS: Record<string, number> = { L: 1, M: 2, X: 3, J: 4, V: 5, S: 6, D: 7 };

/**
 * Interpreta un horario escrito para humanos:
 *
 *     "L-V:08:00-18:00,S:08:00-12:00"
 *
 * Se eligió texto y no una tabla en base porque esto lo cambia administración
 * un martes cualquiera, y una variable de entorno se edita sin desplegar código
 * ni abrir una pantalla que habría que construir.
 *
 * Ante cualquier cosa que no entienda devuelve `null` en vez de adivinar: un
 * horario mal escrito debe dejar la automatización apagada, nunca hacer que la
 * clínica conteste "estamos cerrados" un miércoles a las diez.
 */
export function parsearHorario(texto: string | undefined, zona = ZONA_POR_DEFECTO): HorarioAtencion | null {
  if (!texto?.trim()) return null;

  const tramos: Tramo[] = [];

  for (const bloque of texto.split(',')) {
    const limpio = bloque.trim();

    /* Se corta por el PRIMER `:` — el resto pertenece a la hora (`08:00-18:00`),
       que trae los suyos. */
    const corte = limpio.indexOf(':');
    if (corte < 0) return null;

    const dias = limpio.slice(0, corte);
    const horas = limpio.slice(corte + 1).split('-');
    if (!dias || horas.length !== 2) return null;

    const [desde, hasta] = horas.map(minutosDesdeMedianoche);
    if (desde === null || hasta === null || desde >= hasta) return null;

    for (const dia of expandirDias(dias)) {
      if (dia === null) return null;
      tramos.push({ dia, desde, hasta });
    }
  }

  return tramos.length > 0 ? { tramos, zona } : null;
}

/** `L-V` → [1,2,3,4,5]; `S` → [6]. */
function expandirDias(texto: string): Array<number | null> {
  if (texto.includes('-')) {
    const [a, b] = texto.split('-').map(d => DIAS[d.trim().toUpperCase()] ?? null);
    if (a === null || b === null || a > b) return [null];
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  }
  return [DIAS[texto.trim().toUpperCase()] ?? null];
}

function minutosDesdeMedianoche(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const horas = Number(m[1]);
  const minutos = Number(m[2]);
  if (horas > 23 || minutos > 59) return null;
  return horas * 60 + minutos;
}

/**
 * Día y minuto del reloj EN LA ZONA DE LA CLÍNICA.
 *
 * No se usa `getHours()` a secas a propósito: el VPS está en Estados Unidos, así
 * que su hora local no es la de la clínica. Sin esto, "fuera de horario" se
 * desplazaría varias horas y el sistema contestaría "estamos cerrados" en plena
 * mañana de un martes.
 */
function momentoEnZona(fecha: Date, zona: string): { dia: number; minutos: number } {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: zona,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(fecha);

  const valor = (tipo: string) => partes.find(p => p.type === tipo)?.value ?? '';
  const dias: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

  /* `hour12: false` puede dar "24" a medianoche en algunos entornos. */
  const hora = Number(valor('hour')) % 24;

  return { dia: dias[valor('weekday')] ?? 0, minutos: hora * 60 + Number(valor('minute')) };
}

/** true si la fecha cae dentro de algún tramo de atención. */
export function estaAtendiendo(fecha: Date, horario: HorarioAtencion): boolean {
  const { dia, minutos } = momentoEnZona(fecha, horario.zona);
  return horario.tramos.some(t => t.dia === dia && minutos >= t.desde && minutos < t.hasta);
}
