import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

/**
 * Las horas LIBRES de un médico, calculadas por el CRM.
 *
 * ScriptCase ofrece cupos con su vista `vista_horas_libres`, que cuenta como
 * ocupada CUALQUIER fila de `agenda_med` en esa hora, sin mirar su estado. Pero
 * FileMaker —que escribe `agenda_med` por ODBC— nunca borra: al anular una cita
 * la marca `BORRADO`, y al cambiarla de hora marca la vieja `MODIFICADO` e
 * inserta la nueva como `CREADO`. Medido en el binlog del 4/6 al 7/10/2026:
 * 412 anulaciones de citas futuras y 946 modificaciones (601 a otra fecha u
 * hora). Con la vista, ninguna de esas horas volvía a ofrecerse.
 *
 * Aquí solo ocupa lo vigente, igual que la agenda que el médico ve en
 * ScriptCase (`grid_agenda_med` filtra `estado = 'CREADO'`):
 * - una cita `CREADO` de `agenda_med` **en la casilla que la contiene** (por
 *   `cod_med`, como la vista), o
 * - una reserva web `PENDIENTE` o `PAGADO` de `para_agendar`, que la vista ni miraba.
 *
 * «La casilla que la contiene» y no «esa hora exacta»: FileMaker agenda a `:15`
 * y `:45`, fuera de la grilla de media hora, y comparando la hora exacta esas
 * citas no ocupaban nada. Ver `CASILLA_QUE_CONTIENE` para la medición.
 *
 * No se toca la vista: la sigue usando ScriptCase tal cual.
 */

type Lector = Pick<PoolConnection, 'query'>;

/** Las reservas web que todavía ocupan la hora, aunque no hayan pasado a `agenda_med`. */
export const ESTADOS_QUE_OCUPAN = ['PENDIENTE', 'PAGADO'] as const;

/** El único estado de `agenda_med` que ocupa: las citas vigentes. */
export const ESTADO_CITA_VIGENTE = 'CREADO';

/** Los segundos que dura una casilla de `horarios`: media hora. */
export const SEGUNDOS_CASILLA = 1800;

/**
 * La casilla de 30 minutos que CONTIENE esa hora: `11:45` → `11:30`.
 *
 * FileMaker no agenda en la grilla. Medido en producción el 2026-10-10, de 308
 * citas `CREADO` futuras hay **41 fuera de la grilla** —23 a `:15` y 18 a
 * `:45`, ninguna a otro minuto—, y **24 de ellas caen dentro de una casilla que
 * la web estaba ofreciendo**, en 9 médicos. Comparando `h.hora = a.hora` esas
 * citas no ocupaban nada: la paciente reservaba y llegaba a una consulta
 * tomada.
 *
 * Es el 8% de las citas, y por eso nadie lo había notado. Importa más de aquí
 * en adelante: cualquier cosa que multiplique las reservas multiplica el choque.
 *
 * **Ocupa la casilla que contiene el INICIO de la cita, no las siguientes.**
 * `agenda_med` guarda la hora pero no la duración, así que una cita de 11:45
 * que durara una hora tocaría también la casilla de 12:00 y eso no se puede
 * saber desde la tabla. Suponer una duración quitaría cupos sin fundamento;
 * esto quita exactamente los que constan ocupados.
 */
const CASILLA_QUE_CONTIENE = (columna: string) =>
  `SEC_TO_TIME(FLOOR(TIME_TO_SEC(${columna}) / ${SEGUNDOS_CASILLA}) * ${SEGUNDOS_CASILLA})`;

export interface HoraLibre {
  /** AAAA-MM-DD */
  fecha: string;
  /** HH:MM */
  hora: string;
}

export interface FiltroHorasLibres {
  medicoId: number;
  /** AAAA-MM-DD, incluido. */
  desde: string;
  /** AAAA-MM-DD, incluido. */
  hasta: string;
  /** Solo esta hora (HH:MM): la comprobación de una reserva. */
  hora?: string;
}

/**
 * Las horas libres del médico entre `desde` y `hasta`, futuras (hora de
 * Bolivia), de casillas `ACTIVO` de `horarios`. Ordenadas por fecha y hora.
 */
export async function horasLibres(db: Lector, f: FiltroHorasLibres): Promise<HoraLibre[]> {
  const soloHora = f.hora ? 'AND h.hora = ?' : '';
  // `ocupadas` recorre agenda_med UNA vez (no tiene índices: es de FileMaker y
  // no se le agregan) y deja solo las citas vigentes de este médico en el rango;
  // después todo se cruza contra ese conjunto chico.
  //
  // `query`, NO `execute`: MySQL 8.0.44 (el de la agenda) da resultados
  // EQUIVOCADOS al re-ejecutar esta sentencia preparada —la primera vez descuenta
  // las citas, la segunda en la misma conexión ya no— y mysql2 reutiliza la
  // preparada por conexión. Reproducido el 7/10/2026; lo fija la prueba de
  // integración que consulta dos médicos seguidos. `query` escapa los valores
  // en el cliente: no hay SQL armado con texto del usuario.
  const [filas] = await db.query<RowDataPacket[]>(
    `WITH RECURSIVE fechas AS (
       SELECT CAST(? AS DATE) AS fecha
       UNION ALL SELECT fecha + INTERVAL 1 DAY FROM fechas WHERE fecha < CAST(? AS DATE)
     ),
     turnos AS (
       SELECT DISTINCT f.fecha, h.hora, h.cod_med
         FROM fechas f
         JOIN horarios h ON h.medico_pk = ? AND h.estado = 'ACTIVO' ${soloHora}
          AND h.dia = ELT(DAYOFWEEK(f.fecha), 'Domingo', 'Lunes', 'Martes', 'Miercoles', 'Jueves', 'Viernes', 'Sabado')
     ),
     ocupadas AS (
       SELECT DISTINCT a.cod_med, a.fecha, ${CASILLA_QUE_CONTIENE('a.hora')} AS hora
         FROM agenda_med a
        WHERE a.estado = ? AND a.fecha BETWEEN CAST(? AS DATE) AND CAST(? AS DATE)
          AND a.cod_med IN (SELECT DISTINCT cod_med FROM turnos)
     ),
     reservadas AS (
       SELECT DISTINCT p.fecha, ${CASILLA_QUE_CONTIENE('p.hora')} AS hora
         FROM para_agendar p
        WHERE p.medico_pk = ? AND p.fecha BETWEEN CAST(? AS DATE) AND CAST(? AS DATE)
          AND p.estado IN (${ESTADOS_QUE_OCUPAN.map(() => '?').join(',')})
     )
     SELECT DISTINCT DATE_FORMAT(t.fecha, '%Y-%m-%d') AS fecha, DATE_FORMAT(t.hora, '%H:%i') AS hora
       FROM turnos t
       LEFT JOIN ocupadas o ON o.cod_med = t.cod_med AND o.fecha = t.fecha AND o.hora = t.hora
       LEFT JOIN reservadas r ON r.fecha = t.fecha AND r.hora = t.hora
      WHERE o.fecha IS NULL AND r.fecha IS NULL
        AND (t.fecha > CURRENT_DATE() OR (t.fecha = CURRENT_DATE() AND t.hora > CURRENT_TIME()))
      ORDER BY fecha, hora
      LIMIT 1500`,
    [
      f.desde, f.hasta, f.medicoId, ...(f.hora ? [`${f.hora}:00`] : []),
      ESTADO_CITA_VIGENTE, f.desde, f.hasta,
      f.medicoId, f.desde, f.hasta, ...ESTADOS_QUE_OCUPAN,
    ],
  );
  return (filas as RowDataPacket[]).map(r => ({ fecha: String(r.fecha), hora: String(r.hora) }));
}
