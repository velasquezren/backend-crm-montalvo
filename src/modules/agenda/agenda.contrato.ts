/** Contrato público de lectura v1 sobre el VPS auditado.
 * No representa tablas de ScriptCase ni autoriza reservas o pagos. */
export interface EspecialidadAgenda { id: string; nombre: string }
export interface MedicoAgenda {
  id: string;
  especialidadId: string;
  nombre: string;
  horarioInformativo: string | null;
  modalidad: 'ONLINE' | 'A_SOLICITUD';
  precio: { importeCentavos: number; moneda: 'BOB' } | null;
}
export interface DisponibilidadAgenda {
  medicoId: string;
  fecha: string;
  zonaHoraria: 'America/La_Paz';
  consultadoEn: string;
  estado: 'DISPONIBLE' | 'SIN_CUPOS' | 'SIN_ATENCION' | 'A_SOLICITUD';
  horarios: { id: string; hora: string }[];
}

export const ID_AGENDA = /^[A-Za-z0-9_-]{1,80}$/;
export const FECHA_AGENDA = /^\d{4}-\d{2}-\d{2}$/;
export const HORA_AGENDA = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function invalido(): never { throw new Error('Contrato de agenda inválido'); }
function objeto(valor: unknown): Record<string, unknown> {
  return valor !== null && typeof valor === 'object' && !Array.isArray(valor)
    ? valor as Record<string, unknown> : invalido();
}
function texto(valor: unknown, maximo: number): string {
  return typeof valor === 'string' && valor.trim().length > 0 && valor.length <= maximo
    && !/[\u0000-\u001f]/.test(valor) ? valor : invalido();
}
function id(valor: unknown): string {
  const salida = texto(valor, 80);
  return ID_AGENDA.test(salida) ? salida : invalido();
}
function entero(valor: unknown, minimo: number, maximo: number): number {
  return typeof valor === 'number' && Number.isSafeInteger(valor) && valor >= minimo && valor <= maximo
    ? valor : invalido();
}

/** Proyección explícita: nunca propagar columnas, notas ni datos personales extra. */
export function especialidadDeAgenda(valor: unknown): EspecialidadAgenda {
  const v = objeto(valor);
  return { id: id(v.id), nombre: texto(v.nombre, 210) };
}
export function medicoDeAgenda(valor: unknown): MedicoAgenda {
  const v = objeto(valor);
  if (v.modalidad !== 'ONLINE' && v.modalidad !== 'A_SOLICITUD') invalido();
  let precio: MedicoAgenda['precio'] = null;
  if (v.precio !== null) {
    const p = objeto(v.precio);
    if (p.moneda !== 'BOB') invalido();
    precio = { importeCentavos: entero(p.importeCentavos, 0, 100_000_000), moneda: 'BOB' };
  }
  return {
    id: id(v.id), especialidadId: id(v.especialidadId), nombre: texto(v.nombre, 210),
    horarioInformativo: v.horarioInformativo === null ? null : texto(v.horarioInformativo, 600),
    modalidad: v.modalidad, precio,
  };
}

export function paginaAgenda<T extends { id: string }>(valor: unknown, pagina: number, limite: number, leer: (v: unknown) => T) {
  const v = objeto(valor);
  if (v.version !== 1 || v.pagina !== pagina || v.limite !== limite) invalido();
  const total = entero(v.total, 0, 100_000);
  const totalPaginas = Math.max(1, Math.ceil(total / limite));
  if (v.totalPaginas !== totalPaginas || !Array.isArray(v.datos)
    || v.datos.length !== Math.max(0, Math.min(limite, total - (pagina - 1) * limite))) invalido();
  const datos = (v.datos as unknown[]).map(leer);
  if (new Set(datos.map(d => d.id)).size !== datos.length) invalido();
  return { datos, total, pagina, limite, totalPaginas };
}

export function disponibilidadDeAgenda(valor: unknown, medicoId: string, fecha: string): DisponibilidadAgenda {
  const v = objeto(valor);
  if (v.version !== 1 || v.medicoId !== medicoId || v.fecha !== fecha || v.zonaHoraria !== 'America/La_Paz') invalido();
  const consultadoEn = texto(v.consultadoEn, 35);
  const instante = Date.parse(consultadoEn);
  if (!Number.isFinite(instante) || Date.now() - instante > 60_000 || instante - Date.now() > 5_000) invalido();
  const estado = v.estado;
  if (estado !== 'DISPONIBLE' && estado !== 'SIN_CUPOS' && estado !== 'SIN_ATENCION' && estado !== 'A_SOLICITUD') invalido();
  if (!Array.isArray(v.horarios) || v.horarios.length > 288) invalido();
  const horarios = (v.horarios as unknown[]).map(valor => {
    const h = objeto(valor);
    const hora = texto(h.hora, 5);
    if (!HORA_AGENDA.test(hora)) invalido();
    return { id: id(h.id), hora };
  });
  if ((estado === 'DISPONIBLE') !== (horarios.length > 0)
    || new Set(horarios.map(h => h.id)).size !== horarios.length
    || new Set(horarios.map(h => h.hora)).size !== horarios.length) invalido();
  horarios.sort((a, b) => a.hora.localeCompare(b.hora));
  return { medicoId, fecha, zonaHoraria: 'America/La_Paz', consultadoEn, estado, horarios };
}

export function fechaConsultable(fecha: string, ahora = new Date()): boolean {
  if (!FECHA_AGENDA.test(fecha)) return false;
  const instante = Date.parse(`${fecha}T00:00:00Z`);
  if (!Number.isFinite(instante) || new Date(instante).toISOString().slice(0, 10) !== fecha) return false;
  const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/La_Paz', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ahora);
  const dias = (instante - Date.parse(`${hoy}T00:00:00Z`)) / 86_400_000;
  return dias >= 0 && dias <= 29;
}
