import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { fechaConsultable, ID_AGENDA } from './agenda.contrato';
import { createHash } from 'node:crypto';
import { ESTADOS_QUE_OCUPAN } from './agenda-reserva.sql';

export type RecursoAgendaSql = 'especialidades' | 'medicos' | 'disponibilidad' | 'dias';
type Fila = Record<string, unknown>;
type Lector = Pick<PoolConnection, 'execute'>;
const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miercoles', 'Jueves', 'Viernes', 'Sabado'];

// Especialidad es TEXTO, no una tabla. La clave derivada sirve para navegar;
// no se importa un segundo catálogo al PostgreSQL del CRM.
const ESPECIALIDADES = `WITH especialidades AS (
  SELECT MIN(TRIM(especialidad)) AS nombre FROM medicos
  WHERE estado = 'ACTIVO' AND TRIM(COALESCE(especialidad, '')) <> ''
  GROUP BY TRIM(especialidad)
)`;

async function filas(db: Lector, sql: string, valores: (string | number)[] = []): Promise<Fila[]> {
  const [resultado] = await db.execute<RowDataPacket[]>(sql, valores);
  return resultado as Fila[];
}
function texto(v: unknown): string { if (typeof v !== 'string') throw new Error('Texto inválido'); return v; }
function entero(v: unknown): number {
  const n = typeof v === 'number' || typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Número inválido');
  return n;
}
export function precioDelVps(v: unknown) {
  // NULL y cero en el legado no prueban una consulta gratuita.
  if (typeof v !== 'string' || !/^\d{1,8}\.\d{2}$/.test(v)) return null;
  const [unidad, centavos] = v.split('.');
  const importeCentavos = Number(unidad) * 100 + Number(centavos);
  return importeCentavos > 0 && importeCentavos <= 100_000_000 ? { importeCentavos, moneda: 'BOB' as const } : null;
}
/** Nombre de archivo de imagen tal como lo guarda ScriptCase (`_lib/file/img/<archivo>`). */
export const ARCHIVO_IMAGEN_AGENDA = /^[\w .()-]{1,150}\.(png|jpe?g|webp)$/i;

/** Versión de la foto: cambia si cambia el archivo, así la caché nunca sirve una vieja. */
export function versionDeFoto(foto: unknown): string | null {
  if (typeof foto !== 'string' || !ARCHIVO_IMAGEN_AGENDA.test(foto.trim())) return null;
  return createHash('sha256').update(foto.trim()).digest('hex').slice(0, 16);
}

function modalidad(v: unknown): 'ONLINE' | 'A_SOLICITUD' {
  // Criterio del recorrido público de ScriptCase, sin ejecutar su HTML.
  return v === 1 || v === '1' ? 'ONLINE' : 'A_SOLICITUD';
}

export async function consultarAgendaSql(db: Lector, recurso: RecursoAgendaSql, params: URLSearchParams): Promise<unknown> {
  if (recurso === 'disponibilidad') return disponibilidad(db, params);
  if (recurso === 'dias') return dias(db, params);
  const pagina = Number(params.get('pagina'));
  const limite = Number(params.get('limite'));
  if (!Number.isSafeInteger(pagina) || pagina < 1 || pagina > 10_000 || !Number.isSafeInteger(limite) || limite < 1 || limite > 100) throw new Error('Paginación inválida');
  const offset = (pagina - 1) * limite;
  let datos: Fila[];
  let total: number;
  if (recurso === 'especialidades') {
    const cuenta = await filas(db, `${ESPECIALIDADES} SELECT COUNT(*) AS total FROM especialidades`);
    total = entero(cuenta[0]?.total);
    datos = await filas(db, `${ESPECIALIDADES} SELECT SHA2(nombre, 256) AS id, nombre
      FROM especialidades ORDER BY nombre, id LIMIT ? OFFSET ?`, [String(limite), String(offset)]);
  } else {
    const especialidadId = params.get('especialidadId') ?? '';
    if (!ID_AGENDA.test(especialidadId)) throw new Error('Especialidad inválida');
    const origen = `FROM medicos m JOIN especialidades e ON TRIM(m.especialidad) = e.nombre
      WHERE m.estado = 'ACTIVO' AND SHA2(e.nombre, 256) = ?`;
    const cuenta = await filas(db, `${ESPECIALIDADES} SELECT COUNT(*) AS total ${origen}`, [especialidadId]);
    total = entero(cuenta[0]?.total);
    const medicos = await filas(db, `${ESPECIALIDADES} SELECT m.medico_pk, m.nombre, m.sigla, m.foto, (LENGTH(TRIM(COALESCE(m.horario_html, ''))) > 0) AS horario_publicado, m.precio_con
      ${origen} ORDER BY m.orden, m.nombre, m.medico_pk LIMIT ? OFFSET ?`, [especialidadId, String(limite), String(offset)]);
    // Siete grupos por profesional. No trasladar HTML, teléfonos, login,
    // contraseña, códigos clínicos ni filas individuales del calendario.
    const ids = medicos.map(m => entero(m.medico_pk));
    const horarios = ids.length ? await filas(db, `SELECT medico_pk, dia,
      DATE_FORMAT(MIN(hora), '%H:%i') AS primera, DATE_FORMAT(MAX(hora), '%H:%i') AS ultima
      FROM horarios WHERE estado = 'ACTIVO' AND medico_pk IN (${ids.map(() => '?').join(',')})
      GROUP BY medico_pk, dia`, ids) : [];
    datos = medicos.map(m => {
      const id = String(entero(m.medico_pk));
      const nombre = [typeof m.sigla === 'string' ? m.sigla.trim() : '', texto(m.nombre).trim()].filter(Boolean).join(' ');
      const semanal = horarios.filter(h => String(h.medico_pk) === id)
        .sort((a, b) => (DIAS.indexOf(texto(a.dia)) + 6) % 7 - (DIAS.indexOf(texto(b.dia)) + 6) % 7)
        .map(h => `${texto(h.dia)}: ${h.primera === h.ultima ? texto(h.primera) : `entre ${texto(h.primera)} y ${texto(h.ultima)}`}`).join(' · ');
      return { id, especialidadId, nombre, modalidad: modalidad(m.horario_publicado),
        horarioInformativo: semanal || null, precio: precioDelVps(m.precio_con), fotoVersion: versionDeFoto(m.foto) };
    });
  }
  return { version: 1, datos, total, pagina, limite, totalPaginas: Math.max(1, Math.ceil(total / limite)) };
}

/** Una fila de `vista_horas_libres v` que se puede ofrecer: futura y sin reserva web que la ocupe. */
const HORA_LIBRE = `(v.fecha > CURRENT_DATE() OR (v.fecha = CURRENT_DATE() AND v.hora_disponible > CURRENT_TIME()))
      AND NOT EXISTS (SELECT 1 FROM para_agendar p WHERE p.medico_pk = v.medico_pk AND p.fecha = v.fecha
        AND p.hora = v.hora_disponible AND p.estado IN (${ESTADOS_QUE_OCUPAN.map(() => '?').join(',')}))`;

/** Los días de los próximos 30 con al menos una hora libre: la web solo ofrece esos. */
async function dias(db: Lector, params: URLSearchParams) {
  const medicoId = params.get('medicoId') ?? '';
  if (!/^\d{1,10}$/.test(medicoId)) throw new Error('Consulta inválida');
  const medicos = await filas(db, `SELECT (LENGTH(TRIM(COALESCE(horario_html, ''))) > 0) AS horario_publicado FROM medicos WHERE medico_pk = ? AND estado = 'ACTIVO'`, [medicoId]);
  if (medicos.length !== 1) throw new Error('Profesional no disponible');
  const base = { version: 1, medicoId, zonaHoraria: 'America/La_Paz', consultadoEn: new Date().toISOString() };
  if (modalidad(medicos[0].horario_publicado) === 'A_SOLICITUD') return { ...base, fechas: [] };
  const libres = await filas(db, `SELECT DISTINCT DATE_FORMAT(v.fecha, '%Y-%m-%d') AS fecha
    FROM vista_horas_libres v WHERE v.medico_pk = ? AND v.estado = 'ACTIVO' AND ${HORA_LIBRE}
    ORDER BY fecha LIMIT 31`, [medicoId, ...ESTADOS_QUE_OCUPAN]);
  return { ...base, fechas: libres.map(f => texto(f.fecha)).filter(f => fechaConsultable(f)) };
}

async function disponibilidad(db: Lector, params: URLSearchParams) {
  const medicoId = params.get('medicoId') ?? '';
  const fecha = params.get('fecha') ?? '';
  if (!/^\d{1,10}$/.test(medicoId) || !fechaConsultable(fecha)) throw new Error('Consulta inválida');
  const medicos = await filas(db, `SELECT (LENGTH(TRIM(COALESCE(horario_html, ''))) > 0) AS horario_publicado FROM medicos WHERE medico_pk = ? AND estado = 'ACTIVO'`, [medicoId]);
  if (medicos.length !== 1) throw new Error('Profesional no disponible');
  const base = { version: 1, medicoId, fecha, zonaHoraria: 'America/La_Paz', consultadoEn: new Date().toISOString() };
  if (modalidad(medicos[0].horario_publicado) === 'A_SOLICITUD') return { ...base, estado: 'A_SOLICITUD', horarios: [] };
  const dia = DIAS[new Date(`${fecha}T12:00:00Z`).getUTCDay()];
  const cuenta = await filas(db, `SELECT COUNT(*) AS total FROM horarios
    WHERE medico_pk = ? AND dia = ? AND estado = 'ACTIVO'`, [medicoId, dia]);
  if (entero(cuenta[0]?.total) === 0) return { ...base, estado: 'SIN_ATENCION', horarios: [] };
  const libres = await filas(db, `SELECT DISTINCT DATE_FORMAT(v.hora_disponible, '%H:%i') AS hora
    FROM vista_horas_libres v WHERE v.medico_pk = ? AND v.fecha = ? AND v.estado = 'ACTIVO'
      AND ${HORA_LIBRE}
    ORDER BY hora LIMIT 289`, [medicoId, fecha, ...ESTADOS_QUE_OCUPAN]);
  // La vista manda sobre la ocupación de agenda_med, incluidos estados
  // históricos. Además se ocultan las horas con una reserva web PENDIENTE o
  // PAGADO (la vista de ScriptCase no las descuenta) y las ya pasadas. La
  // reserva vuelve a comprobarlo dentro de su transacción.
  const horarios = libres.map(h => ({ id: `${medicoId}_${fecha}_${texto(h.hora).replace(':', '')}`, hora: texto(h.hora) }));
  return { ...base, estado: horarios.length ? 'DISPONIBLE' : 'SIN_CUPOS', horarios };
}
