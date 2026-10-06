/*
 * El horario semanal de un médico: bloques «día + desde + hasta». Es
 * INFORMATIVO —cuándo suele atender—, no una agenda con cupos: las citas
 * reales siguen en el sistema de la clínica (docs/promociones-y-directorio.md).
 *
 * Todo lo de este archivo es puro: lo usan el service al guardar, la API
 * pública al describirlo y sus pruebas, sin base de datos.
 */

/** ISO 8601: 1 = lunes … 7 = domingo. El mismo número que guarda la base. */
export const DIAS_SEMANA = [1, 2, 3, 4, 5, 6, 7] as const;
export type DiaSemana = (typeof DIAS_SEMANA)[number];

const NOMBRE_DIA: Record<DiaSemana, string> = {
  1: 'lunes', 2: 'martes', 3: 'miércoles', 4: 'jueves', 5: 'viernes', 6: 'sábado', 7: 'domingo',
};

/** Un médico con más bloques que esto en un día es un error de carga, no un horario. */
export const BLOQUES_MAXIMOS_POR_DIA = 4;

/** «08:00», «19:30». `24:00` vale solo como fin («hasta medianoche»). */
export const HORA = /^([01]\d|2[0-4]):([0-5]\d)$/;

export interface BloqueHorario {
  diaSemana: number;
  inicioMinuto: number;
  finMinuto: number;
  lugar?: string | null;
}

/** «08:30» → 510. `null` si no es una hora válida. */
export function minutosDeHora(hora: string): number | null {
  const m = HORA.exec(hora);
  if (!m) return null;
  const minutos = Number(m[1]) * 60 + Number(m[2]);
  return minutos <= 24 * 60 ? minutos : null;
}

/** 510 → «08:30». */
export function horaDeMinutos(minutos: number): string {
  return `${String(Math.floor(minutos / 60)).padStart(2, '0')}:${String(minutos % 60).padStart(2, '0')}`;
}

/**
 * Lo que impide guardar un horario, dicho para quien lo carga. Vacío = válido.
 * Un horario vacío es válido: el médico atiende «a solicitud».
 */
export function erroresDelHorario(bloques: readonly BloqueHorario[]): string[] {
  const errores: string[] = [];
  const porDia = new Map<number, BloqueHorario[]>();
  for (const b of bloques) {
    if (!DIAS_SEMANA.includes(b.diaSemana as DiaSemana)) {
      errores.push(`Día inválido: ${b.diaSemana}.`);
      continue;
    }
    if (b.inicioMinuto < 0 || b.finMinuto > 24 * 60 || b.inicioMinuto >= b.finMinuto) {
      errores.push(`El ${NOMBRE_DIA[b.diaSemana as DiaSemana]}, la hora de fin tiene que ser posterior a la de inicio.`);
      continue;
    }
    porDia.set(b.diaSemana, [...(porDia.get(b.diaSemana) ?? []), b]);
  }
  for (const [dia, delDia] of porDia) {
    const nombre = NOMBRE_DIA[dia as DiaSemana];
    if (delDia.length > BLOQUES_MAXIMOS_POR_DIA) errores.push(`El ${nombre} tiene más de ${BLOQUES_MAXIMOS_POR_DIA} bloques.`);
    const ordenados = [...delDia].sort((a, b) => a.inicioMinuto - b.inicioMinuto);
    for (let i = 1; i < ordenados.length; i++) {
      if (ordenados[i].inicioMinuto < ordenados[i - 1].finMinuto) {
        errores.push(`El ${nombre} hay bloques que se superponen (${horaDeMinutos(ordenados[i - 1].inicioMinuto)}–${horaDeMinutos(ordenados[i - 1].finMinuto)} y ${horaDeMinutos(ordenados[i].inicioMinuto)}–${horaDeMinutos(ordenados[i].finMinuto)}).`);
      }
    }
  }
  return errores;
}

/** Orden de lectura: por día y por hora. */
export function ordenarBloques<T extends BloqueHorario>(bloques: readonly T[]): T[] {
  return [...bloques].sort((a, b) => a.diaSemana - b.diaSemana || a.inicioMinuto - b.inicioMinuto);
}

function listaDeDias(dias: number[]): string {
  const nombres = dias.map(d => NOMBRE_DIA[d as DiaSemana]);
  /* Tres o más días seguidos se dicen como rango: «lunes a viernes». */
  const seguidos = dias.length >= 3 && dias.every((d, i) => i === 0 || d === dias[i - 1] + 1);
  if (seguidos) return `${nombres[0]} a ${nombres[nombres.length - 1]}`;
  return nombres.length === 1 ? nombres[0] : `${nombres.slice(0, -1).join(', ')} y ${nombres[nombres.length - 1]}`;
}

/**
 * El horario en una frase: «Lunes a viernes, 08:00–12:00 · martes, 15:00–19:00».
 * Agrupa los días que tienen exactamente los mismos bloques. Vacío → «Con cita
 * a solicitud». Es lo que muestra la tarjeta de la landing y lo que leerá la IA.
 */
export function resumenDelHorario(bloques: readonly BloqueHorario[]): string {
  if (bloques.length === 0) return 'Con cita a solicitud';
  const porDia = new Map<number, string>();
  for (const b of ordenarBloques(bloques)) {
    const tramo = `${horaDeMinutos(b.inicioMinuto)}–${horaDeMinutos(b.finMinuto)}`;
    porDia.set(b.diaSemana, porDia.has(b.diaSemana) ? `${porDia.get(b.diaSemana)} y ${tramo}` : tramo);
  }
  const grupos = new Map<string, number[]>();
  for (const [dia, tramos] of porDia) grupos.set(tramos, [...(grupos.get(tramos) ?? []), dia]);
  const frase = [...grupos.entries()]
    .sort((a, b) => a[1][0] - b[1][0])
    .map(([tramos, dias]) => `${listaDeDias(dias)}, ${tramos}`)
    .join(' · ');
  return frase.charAt(0).toUpperCase() + frase.slice(1);
}
