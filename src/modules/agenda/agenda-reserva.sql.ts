import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { ESTADOS_QUE_OCUPAN, horasLibres } from './agenda-ocupacion.sql';

export { ESTADOS_QUE_OCUPAN };

/**
 * Escritura en la agenda ScriptCase, IGUAL que su formulario público «Reserva»
 * y su formulario «Pagos» (auditados en docs/auditoria-agenda-vps-2026-10-06.md):
 *
 * - Reserva: `INSERT INTO para_agendar` con las mismas 17 columnas, estado
 *   PENDIENTE, `uno = 1`, fecha y hora de registro del servidor, NIT y razón
 *   social vacíos, y precio y banco copiados de `medicos` en ese momento.
 *   El id es MAX+1, como ScriptCase (la tabla no tiene auto_increment).
 * - Pago: `UPDATE para_agendar SET comprobante, nit, razon_social, estado =
 *   'PAGADO'`. PAGADO significa «comprobante cargado, a verificar por caja»,
 *   no pago confirmado: es lo que hace hoy ScriptCase.
 *
 * Así FileMaker y caja reciben la reserva web exactamente como las de
 * ScriptCase. Dos mejoras que ScriptCase no tiene, y que no cambian el formato:
 * la hora se vuelve a comprobar libre DENTRO de la transacción (con
 * `horasLibres`: también contra reservas PENDIENTE/PAGADO, que la vista de
 * ScriptCase no descuenta), y los
 * escritores del CRM se serializan con un candado de MySQL.
 */

type Conexion = Pick<PoolConnection, 'execute' | 'query'>;
type Fila = Record<string, unknown>;

export interface DatosReserva {
  medicoId: number;
  /** AAAA-MM-DD, fecha civil de Bolivia. */
  fecha: string;
  /** HH:MM, hora de Bolivia. */
  hora: string;
  nombre: string;
  telefono: string;
  ci: string;
  observaciones: string;
}

export type ResultadoReserva =
  | { ok: true; paraAge: number; medicoNombre: string; precio: string | null; bancoId: number | null }
  | { ok: false; motivo: 'MEDICO_NO_DISPONIBLE' | 'HORA_NO_DISPONIBLE' };

async function filas(db: Conexion, sql: string, valores: (string | number | null)[]): Promise<Fila[]> {
  const [resultado] = await db.execute<RowDataPacket[]>(sql, valores);
  return resultado as Fila[];
}

const ES_CLAVE_DUPLICADA = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { errno?: number }).errno === 1062;

/**
 * Registra la reserva. El llamador abre la transacción y tiene el candado.
 * Devuelve `HORA_NO_DISPONIBLE` si alguien la tomó mientras la paciente
 * completaba sus datos: la web le pide elegir otra antes de cobrar nada.
 */
export async function reservarEnAgenda(db: Conexion, d: DatosReserva): Promise<ResultadoReserva> {
  const [medico] = await filas(
    db,
    `SELECT nombre, precio_con, banco FROM medicos WHERE medico_pk = ? AND estado = 'ACTIVO'`,
    [d.medicoId],
  );
  if (!medico) return { ok: false, motivo: 'MEDICO_NO_DISPONIBLE' };

  // Libre según lo vigente (agenda-ocupacion.sql.ts): ni cita CREADO en
  // agenda_med ni reserva web PENDIENTE/PAGADO, y todavía no pasada.
  const libre = await horasLibres(db, { medicoId: d.medicoId, desde: d.fecha, hasta: d.fecha, hora: d.hora });
  if (libre.length === 0) return { ok: false, motivo: 'HORA_NO_DISPONIBLE' };

  const precio = medico.precio_con === null || medico.precio_con === undefined ? null : String(medico.precio_con);
  const bancoId = medico.banco === null || medico.banco === undefined ? null : Number(medico.banco);
  const medicoNombre = typeof medico.nombre === 'string' ? medico.nombre : '';

  /* ScriptCase también escribe aquí con MAX+1 y sin candado: si su id choca con
     el nuestro, la PK lo rechaza y se recalcula. Tres intentos bastan. */
  for (let intento = 0; intento < 3; intento++) {
    const [siguiente] = await filas(db, `SELECT COALESCE(MAX(para_age), 0) + 1 AS id FROM para_agendar`, []);
    const paraAge = Number(siguiente?.id);
    if (!Number.isSafeInteger(paraAge) || paraAge < 1) throw new Error('Id de reserva inválido');
    try {
      await db.execute<ResultSetHeader>(
        `INSERT INTO para_agendar (para_age, medico_pk, fecha, hora, nombre_age, telefono_age, ci_age, obs,
            estado, nom_med, uno, fecha_registro, hora_registro, nit, razon_social, precio_con, banco)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDIENTE', ?, 1, CURRENT_DATE(), CURRENT_TIME(), '', '', ?, ?)`,
        [paraAge, d.medicoId, d.fecha, `${d.hora}:00`, d.nombre, d.telefono, d.ci, d.observaciones,
          medicoNombre, precio, bancoId],
      );
      return { ok: true, paraAge, medicoNombre, precio, bancoId };
    } catch (error) {
      if (!ES_CLAVE_DUPLICADA(error) || intento === 2) throw error;
    }
  }
  throw new Error('No se pudo asignar un id de reserva');
}

export type ResultadoPago =
  | { ok: true; nombre: string; ci: string }
  | { ok: false; motivo: 'NO_ENCONTRADA' | 'YA_NO_PENDIENTE' };

/** Carga el comprobante y deja la reserva en PAGADO (a verificar), solo si sigue PENDIENTE. */
export async function registrarPagoEnAgenda(
  db: Conexion,
  paraAge: number,
  comprobante: Buffer,
  nit: string,
  razonSocial: string,
): Promise<ResultadoPago> {
  const [reserva] = await filas(db, `SELECT estado, nombre_age, ci_age FROM para_agendar WHERE para_age = ?`, [paraAge]);
  if (!reserva) return { ok: false, motivo: 'NO_ENCONTRADA' };
  if (reserva.estado !== 'PENDIENTE') return { ok: false, motivo: 'YA_NO_PENDIENTE' };
  const [resultado] = await db.execute<ResultSetHeader>(
    `UPDATE para_agendar SET comprobante = ?, nit = ?, razon_social = ?, estado = 'PAGADO'
      WHERE para_age = ? AND estado = 'PENDIENTE'`,
    [comprobante, nit, razonSocial, paraAge],
  );
  if (resultado.affectedRows !== 1) return { ok: false, motivo: 'YA_NO_PENDIENTE' };
  return { ok: true, nombre: String(reserva.nombre_age ?? ''), ci: String(reserva.ci_age ?? '') };
}
