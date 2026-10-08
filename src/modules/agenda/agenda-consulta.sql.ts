import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

/**
 * Las reservas de la agenda ScriptCase (`para_agendar`) para las pantallas del
 * CRM. Solo lectura y solo con sesión: aquí sí hay datos de pacientes.
 *
 * Son TODAS las reservas, las hechas en la web nueva y las de ScriptCase: las
 * dos escriben la misma tabla con el mismo formato y no se pueden distinguir.
 */

type Lector = Pick<PoolConnection, 'execute'>;
type Fila = Record<string, unknown>;

/** Estados vistos en producción (6/10/2026). Uno nuevo se muestra tal cual; solo no se puede filtrar por él. */
export const ESTADOS_RESERVA_AGENDA = ['PENDIENTE', 'PAGADO', 'ATENDIDO'] as const;
export type EstadoReservaAgenda = (typeof ESTADOS_RESERVA_AGENDA)[number];

export interface FiltroReservasAgenda {
  desde: string;
  hasta: string;
  estado?: EstadoReservaAgenda;
  /** Nombre, carnet, número de reserva o dígitos del teléfono. */
  buscar?: string;
  skip: number;
  take: number;
}

export interface FilaReservaAgenda {
  id: number;
  fecha: string;
  hora: string;
  medicoId: number | null;
  medico: string;
  especialidad: string | null;
  paciente: string;
  telefono: string | null;
  ci: string | null;
  observaciones: string | null;
  estado: string;
  precio: string | null;
  nit: string | null;
  razonSocial: string | null;
  tieneComprobante: boolean;
  registradaEl: string | null;
  registradaA: string | null;
}

const COLUMNAS = `p.para_age AS id, DATE_FORMAT(p.fecha, '%Y-%m-%d') AS fecha, DATE_FORMAT(p.hora, '%H:%i') AS hora,
  p.medico_pk AS medico_id, COALESCE(NULLIF(TRIM(p.nom_med), ''), m.nombre, '') AS medico, m.especialidad,
  p.nombre_age, p.telefono_age, p.ci_age, p.obs, COALESCE(p.estado, '') AS estado, p.precio_con, p.nit, p.razon_social,
  (p.comprobante IS NOT NULL) AS tiene_comprobante,
  DATE_FORMAT(p.fecha_registro, '%Y-%m-%d') AS registrada_el, DATE_FORMAT(p.hora_registro, '%H:%i') AS registrada_a`;

async function filas(db: Lector, sql: string, valores: (string | number)[]): Promise<Fila[]> {
  const [resultado] = await db.execute<RowDataPacket[]>(sql, valores);
  return resultado as Fila[];
}

const textoONulo = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

function aReserva(f: Fila): FilaReservaAgenda {
  return {
    id: Number(f.id),
    fecha: String(f.fecha ?? ''),
    hora: String(f.hora ?? ''),
    medicoId: f.medico_id === null || f.medico_id === undefined ? null : Number(f.medico_id),
    medico: String(f.medico ?? ''),
    especialidad: textoONulo(f.especialidad),
    paciente: textoONulo(f.nombre_age) ?? '',
    telefono: textoONulo(f.telefono_age),
    ci: textoONulo(f.ci_age),
    observaciones: textoONulo(f.obs),
    estado: String(f.estado ?? ''),
    precio: f.precio_con === null || f.precio_con === undefined ? null : String(f.precio_con),
    nit: textoONulo(f.nit),
    razonSocial: textoONulo(f.razon_social),
    tieneComprobante: Number(f.tiene_comprobante) === 1,
    registradaEl: textoONulo(f.registrada_el),
    registradaA: textoONulo(f.registrada_a),
  };
}

/** `%` y `_` del usuario se buscan literalmente, no como comodines. */
const comoLiteral = (texto: string) => texto.replace(/[\\%_]/g, '\\$&');

/** Una página de reservas del rango, con el total y la cuenta por estado (sin búsqueda ni estado). */
export async function listarReservasAgenda(db: Lector, f: FiltroReservasAgenda) {
  const condiciones = ['p.fecha BETWEEN ? AND ?'];
  const valores: (string | number)[] = [f.desde, f.hasta];
  const porEstado = await filas(
    db,
    `SELECT COALESCE(p.estado, '') AS estado, COUNT(*) AS total FROM para_agendar p WHERE ${condiciones.join(' AND ')} GROUP BY p.estado`,
    valores,
  );
  if (f.estado) {
    condiciones.push('p.estado = ?');
    valores.push(f.estado);
  }
  const buscar = f.buscar?.trim();
  if (buscar) {
    const digitos = buscar.replace(/\D/g, '');
    const alternativas = ['p.nombre_age LIKE ?', 'p.ci_age LIKE ?'];
    const patron = `%${comoLiteral(buscar)}%`;
    const extra: (string | number)[] = [patron, patron];
    if (digitos.length >= 3) {
      alternativas.push("REGEXP_REPLACE(COALESCE(p.telefono_age, ''), '[^0-9]', '') LIKE ?");
      extra.push(`%${digitos}%`);
    }
    if (/^\d{1,10}$/.test(buscar)) {
      alternativas.push('p.para_age = ?');
      extra.push(Number(buscar));
    }
    condiciones.push(`(${alternativas.join(' OR ')})`);
    valores.push(...extra);
  }
  const donde = condiciones.join(' AND ');
  const [cuenta] = await filas(db, `SELECT COUNT(*) AS total FROM para_agendar p WHERE ${donde}`, valores);
  const pagina = await filas(
    db,
    `SELECT ${COLUMNAS} FROM para_agendar p LEFT JOIN medicos m ON m.medico_pk = p.medico_pk
      WHERE ${donde} ORDER BY p.fecha, p.hora, p.para_age LIMIT ? OFFSET ?`,
    [...valores, String(f.take), String(f.skip)],
  );
  return {
    datos: pagina.map(aReserva),
    total: Number(cuenta?.total ?? 0),
    porEstado: Object.fromEntries(porEstado.map(e => [String(e.estado), Number(e.total)])) as Record<string, number>,
  };
}

/**
 * Las reservas de una paciente por su teléfono, desde `desde`. ScriptCase guarda
 * el teléfono como lo escribió la persona («70012345», «+591 700 12345»…), así
 * que se compara por dígitos con y sin el 591.
 */
export async function reservasPorTelefono(db: Lector, local: string, desde: string, limite = 10) {
  const resultado = await filas(
    db,
    `SELECT ${COLUMNAS} FROM para_agendar p LEFT JOIN medicos m ON m.medico_pk = p.medico_pk
      WHERE REGEXP_REPLACE(COALESCE(p.telefono_age, ''), '[^0-9]', '') IN (?, ?) AND p.fecha >= ?
      ORDER BY p.fecha, p.hora, p.para_age LIMIT ?`,
    [local, `591${local}`, desde, String(limite)],
  );
  return resultado.map(aReserva);
}

/** El comprobante (BLOB) de una reserva, o `null`. Se lee solo cuando alguien lo abre. */
export async function comprobanteDeReserva(db: Lector, id: number): Promise<Buffer | null> {
  const [fila] = await filas(db, 'SELECT comprobante FROM para_agendar WHERE para_age = ?', [id]);
  return Buffer.isBuffer(fila?.comprobante) && fila.comprobante.byteLength > 0 ? fila.comprobante : null;
}

/** Descubrimiento con cursor: cada pasada tiene trabajo acotado y ningún
 * OFFSET creciente. Al acabar se reinicia para detectar cambios externos. */
export async function reservasParaSeguimiento(db: Lector, desde: string, despues: number, limite: number): Promise<FilaReservaAgenda[]> {
  return (await filas(db, `SELECT ${COLUMNAS} FROM para_agendar p
    LEFT JOIN medicos m ON m.medico_pk = p.medico_pk
    WHERE p.para_age > ? AND p.fecha >= ? ORDER BY p.para_age LIMIT ?`,
    [despues, desde, String(limite)])).map(aReserva);
}

/** Reconciliar las ya conocidas aunque cambien a una fecha pasada o se borren. */
export async function reservasPorIds(db: Lector, ids: readonly number[]): Promise<FilaReservaAgenda[]> {
  if (!ids.length) return [];
  if (ids.length > 100) throw new Error('Lote de reservas demasiado grande');
  return (await filas(db, `SELECT ${COLUMNAS} FROM para_agendar p
    LEFT JOIN medicos m ON m.medico_pk = p.medico_pk
    WHERE p.para_age IN (${ids.map(() => '?').join(',')}) ORDER BY p.para_age`, [...ids])).map(aReserva);
}
