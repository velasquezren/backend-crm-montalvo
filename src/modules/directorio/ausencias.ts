/*
 * Ausencias de un médico (vacaciones, congreso): lo que leen la agenda, la
 * reserva y el asistente. Sin imports de servicios a propósito: lo usan
 * `DirectorioService` (su dueño) y el módulo `agenda`.
 */

/** Una ausencia como la ven la agenda y la web: días de La Paz, incluidos los dos extremos. */
export interface AusenciaPublica {
  /** «2026-12-20» */
  desde: string;
  /** «2027-01-05», incluido: ese día tampoco atiende. */
  hasta: string;
  /** Lo que se le puede decir a una paciente: «Vacaciones». */
  motivo: string | null;
}

/** La ausencia que cubre ese día (AAAA-MM-DD), o `null` si ese día atiende. */
export function ausenciaDelDia<T extends Pick<AusenciaPublica, 'desde' | 'hasta'>>(ausencias: readonly T[], fecha: string): T | null {
  return ausencias.find(a => a.desde <= fecha && fecha <= a.hasta) ?? null;
}

/** «2026-12-20» + 1 → «2026-12-21». Las fechas civiles se suman en UTC: no hay cambio de hora. */
export function sumarDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/**
 * Las que tocan los días entre `desde` y `hasta` (incluidos), ordenadas, con el
 * día en que vuelve a atender. Ausencias pegadas o encimadas se leen de corrido:
 * «vuelve» es el primer día después de todas.
 */
export function ausenciasEnRango(ausencias: readonly AusenciaPublica[], desde: string, hasta: string): (AusenciaPublica & { vuelve: string })[] {
  const ordenadas = [...ausencias].sort((a, b) => a.desde.localeCompare(b.desde));
  return ordenadas
    .filter(a => a.hasta >= desde && a.desde <= hasta)
    .map(a => {
      let vuelve = sumarDias(a.hasta, 1);
      for (let otra = ausenciaDelDia(ordenadas, vuelve); otra; otra = ausenciaDelDia(ordenadas, vuelve)) vuelve = sumarDias(otra.hasta, 1);
      return { ...a, vuelve };
    });
}
