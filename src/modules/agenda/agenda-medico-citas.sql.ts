import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { FilaCitaAgenda, FilaReservaMedico } from './agenda-medico-citas';

/**
 * Las dos lecturas con las que se arma la agenda de un médico (ver
 * `agenda-medico-citas.ts`). Solo SELECT, por la cuenta `crm_agenda_consulta`, y
 * de cada tabla solo lo que hace falta para decir «a las 09:00, tal paciente»:
 * ni carnet, ni teléfono, ni pago, ni comprobante.
 *
 * `LIMIT`: un médico no tiene 300 pacientes en un día; si los hubiera, es un
 * dato mal cargado y es mejor un tope que una consulta sin él.
 */

type Lector = Pick<PoolConnection, 'execute'>;

export const TOPE_CITAS_POR_DIA = 300;

/** El único estado de `agenda_med` que es una cita vigente (FileMaker nunca borra: anula con BORRADO). */
export const ESTADO_CITA_VIGENTE = 'CREADO';

/** Los estados de `para_agendar` que todavía no están en `agenda_med`. */
export const ESTADOS_RESERVA_SIN_CARGAR = ['PENDIENTE', 'PAGADO'] as const;

/**
 * Las citas vigentes del médico ese día. `agenda_med` identifica al médico por
 * `cod_med`, que es `medicos.codigo`; el CRM lo conoce por `medico_pk`.
 */
export async function citasVigentesDelMedico(db: Lector, medicoId: number, fecha: string): Promise<FilaCitaAgenda[]> {
  const [filas] = await db.execute<RowDataPacket[]>(
    `SELECT DATE_FORMAT(a.hora, '%H:%i') AS hora, a.paciente
       FROM agenda_med a JOIN medicos m ON m.codigo = a.cod_med
      WHERE m.medico_pk = ? AND a.fecha = ? AND a.estado = ?
      ORDER BY a.hora, a.agendam_pk LIMIT ?`,
    [medicoId, fecha, ESTADO_CITA_VIGENTE, String(TOPE_CITAS_POR_DIA)],
  );
  return (filas as RowDataPacket[]).map(f => ({ hora: String(f.hora), paciente: typeof f.paciente === 'string' ? f.paciente : null }));
}

/** Las reservas del médico ese día que recepción todavía no cargó en FileMaker. */
export async function reservasSinCargarDelMedico(db: Lector, medicoId: number, fecha: string): Promise<FilaReservaMedico[]> {
  const [filas] = await db.execute<RowDataPacket[]>(
    `SELECT DATE_FORMAT(p.hora, '%H:%i') AS hora, p.nombre_age, p.estado
       FROM para_agendar p
      WHERE p.medico_pk = ? AND p.fecha = ? AND p.estado IN (${ESTADOS_RESERVA_SIN_CARGAR.map(() => '?').join(',')})
      ORDER BY p.hora, p.para_age LIMIT ?`,
    [medicoId, fecha, ...ESTADOS_RESERVA_SIN_CARGAR, String(TOPE_CITAS_POR_DIA)],
  );
  return (filas as RowDataPacket[]).map(f => ({
    hora: String(f.hora), paciente: typeof f.nombre_age === 'string' ? f.nombre_age : null, estado: String(f.estado ?? ''),
  }));
}
