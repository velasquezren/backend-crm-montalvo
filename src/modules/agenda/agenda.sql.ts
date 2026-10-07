import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { fechaConsultable, ID_AGENDA } from './agenda.contrato';

export type RecursoAgendaSql = 'especialidades' | 'medicos' | 'disponibilidad';
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
function modalidad(v: unknown): 'ONLINE' | 'A_SOLICITUD' {
  // Criterio del recorrido público de ScriptCase, sin ejecutar su HTML.
  return v === 1 || v === '1' ? 'ONLINE' : 'A_SOLICITUD';
}

export async function consultarAgendaSql(db: Lector, recurso: RecursoAgendaSql, params: URLSearchParams): Promise<unknown> {
  if (recurso === 'disponibilidad') return disponibilidad(db, params);
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
    const medicos = await filas(db, `${ESPECIALIDADES} SELECT m.medico_pk, m.nombre, m.sigla, (LENGTH(TRIM(COALESCE(m.horario_html, ''))) > 0) AS horario_publicado, m.precio_con
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
        horarioInformativo: semanal || null, precio: precioDelVps(m.precio_con) };
    });
  }
  return { version: 1, datos, total, pagina, limite, totalPaginas: Math.max(1, Math.ceil(total / limite)) };
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
  const libres = await filas(db, `SELECT DISTINCT DATE_FORMAT(hora_disponible, '%H:%i') AS hora
    FROM vista_horas_libres WHERE medico_pk = ? AND fecha = ? AND estado = 'ACTIVO'
      AND (fecha > CURRENT_DATE() OR (fecha = CURRENT_DATE() AND hora_disponible > CURRENT_TIME()))
    ORDER BY hora LIMIT 289`, [medicoId, fecha]);
  // La vista manda sobre ocupación, incluidos estados históricos. Solo se
  // ocultan horas pasadas; nunca se promete un bloqueo o reserva transaccional.
  const horarios = libres.map(h => ({ id: `${medicoId}_${fecha}_${texto(h.hora).replace(':', '')}`, hora: texto(h.hora) }));
  return { ...base, estado: horarios.length ? 'DISPONIBLE' : 'SIN_CUPOS', horarios };
}
