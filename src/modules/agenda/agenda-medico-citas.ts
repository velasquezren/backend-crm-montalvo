/**
 * La agenda de UN médico en UN día, armada con lo que ya está en la agenda de la
 * clínica. Puro: sin base ni red, y se prueba. Lo usa el asistente cuando un
 * médico autorizado pregunta por sus pacientes; la IA no calcula nada de esto.
 *
 * ## De dónde sale cada cita (y por qué no se cuenta dos veces)
 *
 * Una reserva circula así (`docs/ia-herramientas.md`): entra en `para_agendar`
 * PENDIENTE, recepción la carga en FileMaker —que escribe `agenda_med` CREADO— y
 * recién entonces marca la reserva ATENDIDO. Por eso la agenda del médico es:
 *
 * - `agenda_med` en estado **CREADO** → «Confirmada». BORRADO es una cita anulada
 *   y MODIFICADO la que se movió (la nueva es otra fila CREADO): ninguna cuenta.
 * - `para_agendar` **PENDIENTE** → «Por confirmar», y **PAGADO** → «Pago por
 *   verificar»: todavía no están en `agenda_med`. Es la misma regla con la que
 *   `horasLibres` decide qué hora ocupa.
 * - `para_agendar` **ATENDIDO** no se lee: ya está en `agenda_med`.
 *
 * Queda un caso intermedio: recepción ya la cargó en FileMaker pero no marcó la
 * reserva. Sin cuidado saldría dos veces; se junta cuando es la misma paciente en
 * la misma casilla de media hora (`SOLAPE`), y gana la confirmada.
 */

export type EstadoCitaMedico = 'CONFIRMADA' | 'POR_CONFIRMAR' | 'PAGO_POR_VERIFICAR';

/** Como lo leen el médico y recepción (las mismas palabras de la pantalla Reservas). */
export const ETIQUETA_ESTADO_CITA: Readonly<Record<EstadoCitaMedico, string>> = {
  CONFIRMADA: 'Confirmada',
  POR_CONFIRMAR: 'Por confirmar',
  PAGO_POR_VERIFICAR: 'Pago por verificar',
};

/** Lo mínimo que se lee de `agenda_med`. */
export interface FilaCitaAgenda {
  readonly hora: string;
  readonly paciente: string | null;
  /** «Ecografía FIV», «Laparoscopia»: lo que FileMaker anota en la columna Actividad. */
  readonly actividad?: string | null;
  /** «Particular» o el nombre del seguro. */
  readonly seguro?: string | null;
}

/** Lo mínimo que se lee de `para_agendar`: sin carnet, teléfono, pago ni comprobante. */
export interface FilaReservaMedico {
  readonly hora: string;
  readonly paciente: string | null;
  readonly estado: string;
}

export interface CitaMedico {
  /** HH:MM, hora de Bolivia. */
  readonly hora: string;
  readonly paciente: string;
  readonly estado: EstadoCitaMedico;
  /** Solo las de FileMaker: una reserva todavía no tiene actividad ni seguro. */
  readonly actividad?: string;
  readonly seguro?: string;
}

export interface AgendaDelDia {
  /** AAAA-MM-DD. */
  readonly fecha: string;
  readonly citas: readonly CitaMedico[];
  readonly confirmadas: number;
  /** «Por confirmar» más «Pago por verificar»: lo que recepción aún no cerró. */
  readonly pendientes: number;
  readonly porConfirmar: number;
  readonly pagoPorVerificar: number;
  readonly total: number;
}

const SIN_NOMBRE = 'Sin nombre registrado';
/** FileMaker agenda a :15 y :45; las casillas de la agenda son de 30 minutos. */
const SOLAPE_MINUTOS = 30;

const ESTADO_DE_RESERVA: Readonly<Record<string, EstadoCitaMedico>> = {
  PENDIENTE: 'POR_CONFIRMAR',
  PAGADO: 'PAGO_POR_VERIFICAR',
};

export function minutosDeHora(hora: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(hora);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** «María  Pérez» y «maria perez» son la misma persona para juntar dos filas. */
export function nombreComparable(nombre: string | null): string {
  return (nombre ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

const sinEspacios = (texto: string | null | undefined) => texto?.replace(/\s+/g, ' ').trim() || undefined;
const limpio = (nombre: string | null) => sinEspacios(nombre) ?? SIN_NOMBRE;

/** Actividad y seguro, solo si FileMaker anotó algo: sin claves vacías. */
function detalleDe(f: FilaCitaAgenda): Pick<CitaMedico, 'actividad' | 'seguro'> {
  const actividad = sinEspacios(f.actividad);
  const seguro = sinEspacios(f.seguro);
  return { ...(actividad && { actividad }), ...(seguro && { seguro }) };
}

export function armarAgendaDelDia(fecha: string, agenda: readonly FilaCitaAgenda[], reservas: readonly FilaReservaMedico[]): AgendaDelDia {
  const confirmadas: CitaMedico[] = agenda.map(f => ({ hora: f.hora.slice(0, 5), paciente: limpio(f.paciente), estado: 'CONFIRMADA', ...detalleDe(f) }));
  const pendientes: CitaMedico[] = [];
  for (const r of reservas) {
    const estado = ESTADO_DE_RESERVA[r.estado];
    /* Un estado que no conocemos (ATENDIDO u otro nuevo) no se cuenta: contar de más
       es decirle al médico que tiene una paciente que quizá no viene. */
    if (!estado) continue;
    const minutos = minutosDeHora(r.hora);
    const nombre = nombreComparable(r.paciente);
    const yaConfirmada = nombre !== '' && minutos !== null && confirmadas.some(c => {
      const cm = minutosDeHora(c.hora);
      return cm !== null && Math.abs(cm - minutos) < SOLAPE_MINUTOS && nombreComparable(c.paciente) === nombre;
    });
    if (!yaConfirmada) pendientes.push({ hora: r.hora.slice(0, 5), paciente: limpio(r.paciente), estado });
  }
  const citas = [...confirmadas, ...pendientes].sort((a, b) => a.hora.localeCompare(b.hora) || a.paciente.localeCompare(b.paciente, 'es'));
  const porConfirmar = pendientes.filter(c => c.estado === 'POR_CONFIRMAR').length;
  const pagoPorVerificar = pendientes.filter(c => c.estado === 'PAGO_POR_VERIFICAR').length;
  return { fecha, citas, confirmadas: confirmadas.length, pendientes: pendientes.length, porConfirmar, pagoPorVerificar, total: citas.length };
}
