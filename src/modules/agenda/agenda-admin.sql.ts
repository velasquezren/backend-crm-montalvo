import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { createHash } from 'node:crypto';
import { precioDelVps, versionDeFoto } from './agenda.sql';
import { CasillaActiva, DIAS_AGENDA, DiaAgenda, HORA_CASILLA, horarioHtml, horasDeLaGrilla } from './horario-html';

/**
 * Administración de médicos y horarios de la agenda ScriptCase desde el CRM,
 * escribiendo IGUAL que sus formularios `form_medicos` y `form_horarios`
 * (auditados el 7/10/2026):
 *
 * - médico nuevo: `INSERT INTO medicos` con id MAX+1 (la tabla no tiene
 *   auto_increment), y `orden` 0 si no se indica;
 * - edición: `UPDATE medicos` de las mismas columnas que ScriptCase, salvo el
 *   `codigo`: es el código de FileMaker, lo leen FileMaker por ODBC y
 *   `agenda_med`, y una vez creado no se toca;
 * - horario: las casillas de `horarios` se encienden y apagan con `estado`; una
 *   que no existía se inserta con `orden` 0 y `cod_med` = `medicos.codigo`,
 *   como el formulario. No se borra ninguna fila. Después se regenera
 *   `horario_html` (ver `horario-html.ts`).
 *
 * El llamador abre la transacción y tiene el candado (`AgendaAdminClient`). La
 * edición es optimista: cada ficha viaja con una `version` (huella de lo que se
 * leyó) y no se guarda encima de un cambio que la persona no vio, venga del CRM
 * o del panel de ScriptCase.
 */

type Conexion = Pick<PoolConnection, 'execute'>;
type Fila = Record<string, unknown>;
type Valor = string | number | null;

export const ESTADOS_MEDICO_AGENDA = ['ACTIVO', 'INACTIVO'] as const;
export type EstadoMedicoAgenda = (typeof ESTADOS_MEDICO_AGENDA)[number];

/** `horarios.cod_med` es VARCHAR(20): el código de un médico nuevo no puede ser más largo. */
export const CODIGO_MEDICO_AGENDA = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,19}$/;

async function filas(db: Conexion, sql: string, valores: Valor[] = []): Promise<Fila[]> {
  const [resultado] = await db.execute<RowDataPacket[]>(sql, valores);
  return resultado as Fila[];
}

const textoONulo = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const enteroONulo = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));
/** `precio_con` tal como está (DECIMAL como texto), o null. */
const decimalONulo = (v: unknown) => (v === null || v === undefined ? null : String(v));
/** `%` y `_` del usuario se buscan literalmente, no como comodines. */
const comoLiteral = (texto: string) => texto.replace(/[\\%_]/g, '\\$&');

export interface MedicoAgendaAdmin {
  id: number;
  /** Código de FileMaker (`medicos.codigo`). Solo lectura. */
  codigo: string | null;
  nombre: string;
  sigla: string | null;
  especialidad: string | null;
  telefono: string | null;
  estado: string;
  /** Precio de la consulta como lo guarda la agenda («400.00»), o null. */
  precio: string | null;
  /** Precio interpretable (null también si la agenda tiene 0: no prueba una consulta gratuita). */
  precioPublico: ReturnType<typeof precioDelVps>;
  bancoId: number | null;
  orden: number;
  /** Con `horario_html` la web lo reserva en línea; sin él, «a solicitud». */
  reservaEnLinea: boolean;
  casillasActivas: number;
  fotoVersion: string | null;
}

const COLUMNAS_MEDICO = `m.medico_pk, m.codigo, m.nombre, m.sigla, m.especialidad, m.telefono, m.estado, m.precio_con,
  m.banco, m.orden, m.foto, (LENGTH(TRIM(COALESCE(m.horario_html, ''))) > 0) AS en_linea`;

function aMedico(f: Fila, casillasActivas: number): MedicoAgendaAdmin {
  const precio = decimalONulo(f.precio_con);
  return {
    id: Number(f.medico_pk),
    codigo: textoONulo(f.codigo),
    nombre: textoONulo(f.nombre) ?? '',
    sigla: textoONulo(f.sigla),
    especialidad: textoONulo(f.especialidad),
    telefono: textoONulo(f.telefono),
    estado: String(f.estado ?? ''),
    precio,
    precioPublico: precioDelVps(precio),
    bancoId: enteroONulo(f.banco),
    orden: enteroONulo(f.orden) ?? 0,
    reservaEnLinea: Number(f.en_linea) === 1,
    casillasActivas,
    fotoVersion: versionDeFoto(f.foto),
  };
}

export interface FiltroMedicosAgenda {
  buscar?: string;
  /** Nombre exacto (sin espacios a los lados) de la especialidad. */
  especialidad?: string;
  estado?: EstadoMedicoAgenda;
  skip: number;
  take: number;
}

/** Una página de médicos (activos e inactivos), con el total y la cuenta por estado del resto de filtros. */
export async function listarMedicosAgenda(db: Conexion, f: FiltroMedicosAgenda) {
  const condiciones: string[] = [];
  const valores: Valor[] = [];
  const buscar = f.buscar?.trim();
  if (buscar) {
    const patron = `%${comoLiteral(buscar)}%`;
    condiciones.push('(m.nombre LIKE ? OR m.codigo LIKE ? OR m.especialidad LIKE ?)');
    valores.push(patron, patron, patron);
  }
  if (f.especialidad) {
    condiciones.push('TRIM(m.especialidad) = ?');
    valores.push(f.especialidad.trim());
  }
  const base = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';
  const porEstado = await filas(db, `SELECT COALESCE(m.estado, '') AS estado, COUNT(*) AS total FROM medicos m ${base} GROUP BY m.estado`, valores);
  if (f.estado) {
    condiciones.push('m.estado = ?');
    valores.push(f.estado);
  }
  const donde = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';
  const [cuenta] = await filas(db, `SELECT COUNT(*) AS total FROM medicos m ${donde}`, valores);
  const pagina = await filas(
    db,
    `SELECT ${COLUMNAS_MEDICO}, COALESCE(h.activas, 0) AS activas
       FROM medicos m
       LEFT JOIN (SELECT medico_pk, COUNT(*) AS activas FROM horarios WHERE estado = 'ACTIVO' GROUP BY medico_pk) h
         ON h.medico_pk = m.medico_pk
       ${donde}
      ORDER BY m.estado = 'ACTIVO' DESC, m.orden, m.nombre, m.medico_pk LIMIT ? OFFSET ?`,
    [...valores, String(f.take), String(f.skip)],
  );
  return {
    datos: pagina.map(m => aMedico(m, Number(m.activas))),
    total: Number(cuenta?.total ?? 0),
    porEstado: Object.fromEntries(porEstado.map(e => [String(e.estado), Number(e.total)])) as Record<string, number>,
  };
}

/** Las especialidades como están escritas en la agenda (texto libre), con cuántos médicos tiene cada una. */
export async function listarEspecialidadesAgenda(db: Conexion, skip: number, take: number) {
  const grupo = `FROM medicos WHERE TRIM(COALESCE(especialidad, '')) <> '' GROUP BY TRIM(especialidad)`;
  const [cuenta] = await filas(db, `SELECT COUNT(*) AS total FROM (SELECT 1 ${grupo}) e`);
  const datos = await filas(
    db,
    `SELECT MIN(TRIM(especialidad)) AS nombre, COUNT(*) AS medicos, SUM(estado = 'ACTIVO') AS activos
       ${grupo} ORDER BY nombre LIMIT ? OFFSET ?`,
    [String(take), String(skip)],
  );
  return {
    datos: datos.map(e => ({ nombre: String(e.nombre), medicos: Number(e.medicos), activos: Number(e.activos ?? 0) })),
    total: Number(cuenta?.total ?? 0),
  };
}

/** Los QR de cobro (`pagos_qr`) que se pueden asignar a un médico. */
export async function listarBancosAgenda(db: Conexion) {
  const datos = await filas(db, `SELECT qr_pk, banco, DATE_FORMAT(fecha_vence, '%Y-%m-%d') AS vence FROM pagos_qr ORDER BY banco, qr_pk LIMIT 100`);
  return datos.map(b => ({ id: Number(b.qr_pk), nombre: textoONulo(b.banco) ?? `QR ${String(b.qr_pk)}`, vence: textoONulo(b.vence) }));
}

export interface CasillaAgenda {
  id: number;
  dia: string;
  hora: string;
  activa: boolean;
}

export interface FichaMedicoAgenda {
  medico: MedicoAgendaAdmin;
  casillas: CasillaAgenda[];
  /** Las filas y columnas de la grilla de horario: la regla vive aquí y no en la pantalla. */
  grilla: { dias: readonly DiaAgenda[]; horas: string[] };
  /** Huella de lo leído: se devuelve al guardar para no pisar un cambio ajeno. */
  version: string;
}

/** La ficha de un médico con TODAS sus casillas de horario, o null si no existe. */
export async function fichaMedicoAgenda(db: Conexion, id: number): Promise<FichaMedicoAgenda | null> {
  const [fila] = await filas(db, `SELECT ${COLUMNAS_MEDICO} FROM medicos m WHERE m.medico_pk = ?`, [id]);
  if (!fila) return null;
  const horarios = await filas(
    db,
    `SELECT id_hora, dia, DATE_FORMAT(hora, '%H:%i') AS hora, estado FROM horarios WHERE medico_pk = ? ORDER BY dia, hora, id_hora`,
    [id],
  );
  const casillas = horarios.map(h => ({ id: Number(h.id_hora), dia: String(h.dia ?? ''), hora: String(h.hora ?? ''), activa: h.estado === 'ACTIVO' }));
  const medico = aMedico(fila, casillas.filter(c => c.activa).length);
  const version = createHash('sha256')
    .update(JSON.stringify([medico, casillas]))
    .digest('hex')
    .slice(0, 16);
  const horas = horasDeLaGrilla(casillas.filter(c => (DIAS_AGENDA as readonly string[]).includes(c.dia)).map(c => c.hora));
  return { medico, casillas, grilla: { dias: DIAS_AGENDA, horas }, version };
}

/** Los datos del médico que el CRM edita. El código de FileMaker no está, a propósito. */
export interface DatosMedicoAgenda {
  nombre: string;
  sigla: string | null;
  especialidad: string;
  telefono: string | null;
  estado: EstadoMedicoAgenda;
  /** «400» o «400.50», en Bs; null = sin precio. */
  precio: string | null;
  bancoId: number | null;
  orden: number;
}

export type ResultadoAdminAgenda<T> =
  | { ok: true; valor: T }
  | { ok: false; motivo: 'NO_ENCONTRADO' | 'CONFLICTO' | 'BANCO_INEXISTENTE' | 'SIN_CODIGO' | 'CASILLA_INVALIDA' | 'CODIGO_DUPLICADO' };

async function bancoExiste(db: Conexion, bancoId: number | null): Promise<boolean> {
  if (bancoId === null) return true;
  return (await filas(db, `SELECT 1 FROM pagos_qr WHERE qr_pk = ?`, [bancoId])).length === 1;
}

/** Lee la ficha y comprueba que nadie la cambió desde que la persona la abrió. */
async function fichaVigente(db: Conexion, id: number, version: string): Promise<ResultadoAdminAgenda<FichaMedicoAgenda>> {
  const ficha = await fichaMedicoAgenda(db, id);
  if (!ficha) return { ok: false, motivo: 'NO_ENCONTRADO' };
  if (ficha.version !== version) return { ok: false, motivo: 'CONFLICTO' };
  return { ok: true, valor: ficha };
}

/** Actualiza los datos del médico (no su código ni su horario). Devuelve la ficha anterior, para la auditoría. */
export async function actualizarMedicoAgenda(
  db: Conexion,
  id: number,
  version: string,
  d: DatosMedicoAgenda,
): Promise<ResultadoAdminAgenda<FichaMedicoAgenda>> {
  const vigente = await fichaVigente(db, id, version);
  if (!vigente.ok) return vigente;
  if (!(await bancoExiste(db, d.bancoId))) return { ok: false, motivo: 'BANCO_INEXISTENTE' };
  await db.execute<ResultSetHeader>(
    `UPDATE medicos SET nombre = ?, sigla = ?, especialidad = ?, telefono = ?, estado = ?, precio_con = ?, banco = ?, orden = ?
      WHERE medico_pk = ?`,
    [d.nombre, d.sigla ?? '', d.especialidad, d.telefono ?? '', d.estado, d.precio, d.bancoId, d.orden, id],
  );
  return vigente;
}

export interface CambiosHorario {
  encendidas: number;
  apagadas: number;
  creadas: number;
  horarioHtml: string;
}

/**
 * Deja encendidas EXACTAMENTE las casillas pedidas (de Lunes a Sabado) y apaga
 * el resto; regenera `horario_html`. Una casilla con un día que la grilla no
 * conoce no se toca.
 */
export async function guardarHorarioAgenda(
  db: Conexion,
  id: number,
  version: string,
  activas: readonly CasillaActiva[],
): Promise<ResultadoAdminAgenda<CambiosHorario>> {
  const vigente = await fichaVigente(db, id, version);
  if (!vigente.ok) return vigente;
  const { medico, casillas } = vigente.valor;

  const clave = (dia: string, hora: string) => `${dia} ${hora}`;
  const existentes = new Set(casillas.map(c => clave(c.dia, c.hora)));
  const pedidas = new Map<string, CasillaActiva>();
  for (const c of activas) {
    if (!(DIAS_AGENDA as readonly string[]).includes(c.dia)) return { ok: false, motivo: 'CASILLA_INVALIDA' };
    if (!HORA_CASILLA.test(c.hora) && !existentes.has(clave(c.dia, c.hora))) return { ok: false, motivo: 'CASILLA_INVALIDA' };
    pedidas.set(clave(c.dia, c.hora), c);
  }

  // Una casilla nueva necesita el código de FileMaker (`cod_med`): sin él la
  // vista de horas libres no la cruza con `agenda_med`. Se comprueba antes de escribir nada.
  const nuevas = [...pedidas.values()].filter(c => !existentes.has(clave(c.dia, c.hora)));
  if (nuevas.length > 0 && !medico.codigo) return { ok: false, motivo: 'SIN_CODIGO' };

  let encendidas = 0;
  let apagadas = 0;
  for (const c of casillas) {
    if (!(DIAS_AGENDA as readonly string[]).includes(c.dia)) continue;
    const debeEstarActiva = pedidas.has(clave(c.dia, c.hora));
    if (debeEstarActiva === c.activa) continue;
    await db.execute<ResultSetHeader>(`UPDATE horarios SET estado = ? WHERE id_hora = ? AND medico_pk = ?`, [
      debeEstarActiva ? 'ACTIVO' : 'INACTIVO', c.id, id,
    ]);
    if (debeEstarActiva) encendidas++;
    else apagadas++;
  }

  for (const c of nuevas) {
    await db.execute<ResultSetHeader>(
      `INSERT INTO horarios (hora, orden, dia, medico_pk, cod_med, estado) VALUES (?, 0, ?, ?, ?, 'ACTIVO')`,
      [`${c.hora}:00`, c.dia, id, medico.codigo],
    );
  }

  const html = horarioHtml([...pedidas.values()].map(c => ({ dia: c.dia as DiaAgenda, hora: c.hora })));
  await db.execute<ResultSetHeader>(`UPDATE medicos SET horario_html = ? WHERE medico_pk = ?`, [html, id]);
  return { ok: true, valor: { encendidas, apagadas, creadas: nuevas.length, horarioHtml: html } };
}

/** Alta de un médico, como `form_medicos`: id MAX+1 y el código de FileMaker que da la clínica. */
export async function crearMedicoAgenda(
  db: Conexion,
  codigo: string,
  d: DatosMedicoAgenda,
): Promise<ResultadoAdminAgenda<{ id: number }>> {
  if (!(await bancoExiste(db, d.bancoId))) return { ok: false, motivo: 'BANCO_INEXISTENTE' };
  // La colación de la base no distingue mayúsculas ni tildes: «ab-1» choca con «AB-1».
  if ((await filas(db, `SELECT 1 FROM medicos WHERE TRIM(codigo) = ? LIMIT 1`, [codigo])).length > 0) {
    return { ok: false, motivo: 'CODIGO_DUPLICADO' };
  }
  /* ScriptCase también da el id con MAX+1 y sin candado: si choca, la PK lo rechaza y se recalcula. */
  for (let intento = 0; intento < 3; intento++) {
    const [siguiente] = await filas(db, `SELECT COALESCE(MAX(medico_pk), 0) + 1 AS id FROM medicos`);
    const id = Number(siguiente?.id);
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('Id de médico inválido');
    try {
      await db.execute<ResultSetHeader>(
        `INSERT INTO medicos (medico_pk, codigo, nombre, sigla, especialidad, telefono, estado, horario_html, orden, precio_con, banco)
         VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)`,
        [id, codigo, d.nombre, d.sigla ?? '', d.especialidad, d.telefono ?? '', d.estado, d.orden, d.precio, d.bancoId],
      );
      return { ok: true, valor: { id } };
    } catch (error) {
      const duplicada = typeof error === 'object' && error !== null && (error as { errno?: number }).errno === 1062;
      if (!duplicada || intento === 2) throw error;
    }
  }
  throw new Error('No se pudo asignar un id de médico');
}

/**
 * Renombra una especialidad en todos los médicos que la tienen (activos e
 * inactivos). Si el nombre nuevo ya existe, las dos quedan unificadas.
 */
export async function renombrarEspecialidadAgenda(db: Conexion, actual: string, nueva: string): Promise<number> {
  const [resultado] = await db.execute<ResultSetHeader>(`UPDATE medicos SET especialidad = ? WHERE TRIM(especialidad) = ?`, [nueva, actual]);
  return resultado.affectedRows;
}
