import { Logger } from '@nestjs/common';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { FilaCitaAgenda, FilaReservaMedico } from './agenda-medico-citas';

/**
 * Las dos lecturas con las que se arma la agenda de un médico (ver
 * `agenda-medico-citas.ts`). Solo SELECT, por la cuenta `crm_agenda_consulta`, y
 * de cada tabla solo lo que hace falta para decir «a las 09:00, tal paciente,
 * Ecografía FIV, Particular» —lo mismo que el médico ve en su pantalla de
 * FileMaker—: ni carnet, ni teléfono, ni pago, ni comprobante.
 *
 * `LIMIT`: un médico no tiene 300 pacientes en un día; si los hubiera, es un
 * dato mal cargado y es mejor un tope que una consulta sin él.
 */

type Lector = Pick<PoolConnection, 'execute'>;

const logger = new Logger('AgendaMedicoCitas');
const texto = (v: unknown) => (typeof v === 'string' ? v : null);

/** Lo que FileMaker anota de cada cita y el médico ve en su pantalla. */
const COLUMNAS_DETALLE = ', a.actividad, a.seguro';
/** Sin permiso para esas columnas (ER_COLUMNACCESS_DENIED_ERROR) o si no existieran (ER_BAD_FIELD_ERROR). */
const SIN_DETALLE = new Set([1143, 1054]);

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
  const consulta = (detalle: string) => db.execute<RowDataPacket[]>(
    `SELECT DATE_FORMAT(a.hora, '%H:%i') AS hora, a.paciente${detalle}
       FROM agenda_med a JOIN medicos m ON m.codigo = a.cod_med
      WHERE m.medico_pk = ? AND a.fecha = ? AND a.estado = ?
      ORDER BY a.hora, a.agendam_pk LIMIT ?`,
    [medicoId, fecha, ESTADO_CITA_VIGENTE, String(TOPE_CITAS_POR_DIA)],
  );
  let filas: RowDataPacket[];
  try {
    [filas] = await consulta(COLUMNAS_DETALLE);
  } catch (e) {
    if (!SIN_DETALLE.has((e as { errno?: number }).errno ?? 0)) throw e;
    /* Sin el permiso de esas dos columnas la agenda sale igual, sin el renglón de
       actividad y seguro: un detalle de más nunca deja al médico sin su agenda. */
    logger.warn('agenda_med: sin permiso para actividad/seguro; la agenda del médico sale sin ese renglón (scripts/agenda/permisos-agenda-medicos.sh).');
    [filas] = await consulta('');
  }
  return filas.map(f => ({
    hora: String(f.hora), paciente: texto(f.paciente), actividad: texto(f.actividad), seguro: texto(f.seguro),
  }));
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
    hora: String(f.hora), paciente: texto(f.nombre_age), estado: String(f.estado ?? ''),
  }));
}
