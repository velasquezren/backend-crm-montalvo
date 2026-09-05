import { EstadoPeriodo } from '../../prisma/prisma-client';

/**
 * Ciclo de vida de un mes de liquidación: qué salto es legal y qué se puede
 * tocar en cada estado.
 *
 * ## Por qué existe este archivo
 *
 * Hasta el 2026-08-28 no había máquina de estados: `cambiarEstado()` hacía un
 * `update({ data: { estado } })` con el valor que llegara, sin comprobar nada.
 * `CERRADO → BORRADOR` era legal, así que el candado de un mes ya pagado
 * dependía de que nadie eligiera mal en un `<select>`. Peor: reabrir era
 * `@Roles('ADMIN')` mientras que BORRAR el periodo era `@Roles('SUPER_ADMIN')`
 * —al revés de lo que conviene, porque reabrir permite recalcular y cambiar
 * lo que a alguien ya se le pagó—.
 *
 * Se separa del service a propósito: son reglas puras, sin base de datos, y
 * las prueba `estados-periodo.spec.ts` sin montar nada.
 *
 * ## El grafo
 *
 * ```
 * BORRADOR ──calcular──▶ CALCULADO ──enviar a revisión──▶ EN_REVISION
 *     ▲                    │  ▲                            │      │
 *     └──reimportar────────┘  └───rechazar (con motivo)─────┘      │ aprueban todos
 *                             ▲                                   ▼
 *                             └──reabrir (SUPER_ADMIN + motivo)── CERRADO
 *                                                                  │
 *                                                        registrar pago
 *                                                                  ▼
 *                                                               PAGADO
 * ```
 *
 * `PAGADO` es terminal **a propósito**. Una planilla pagada no se reescribe: si
 * apareció un error, se corrige con un ajuste en el mes siguiente, que es como
 * lo resuelve administración y como queda rastro de que hubo una corrección.
 * Dejar reabrir un mes pagado convierte el historial en algo que no se puede
 * citar.
 */
export const TRANSICIONES: Record<EstadoPeriodo, readonly EstadoPeriodo[]> = {
  [EstadoPeriodo.BORRADOR]: [EstadoPeriodo.CALCULADO],
  [EstadoPeriodo.CALCULADO]: [EstadoPeriodo.BORRADOR, EstadoPeriodo.EN_REVISION],
  [EstadoPeriodo.EN_REVISION]: [EstadoPeriodo.CALCULADO, EstadoPeriodo.CERRADO],
  [EstadoPeriodo.CERRADO]: [EstadoPeriodo.CALCULADO, EstadoPeriodo.PAGADO],
  [EstadoPeriodo.PAGADO]: [],
} as const;

export function transicionPermitida(desde: EstadoPeriodo, hasta: EstadoPeriodo): boolean {
  return TRANSICIONES[desde].includes(hasta);
}

/**
 * Estados en los que todavía se pueden tocar los datos del mes: reimportar,
 * reclasificar, corregir una fila, recalcular o borrar el periodo.
 *
 * **Sustituye a los `estado === CERRADO` sueltos que había repartidos por el
 * módulo.** Eran cinco comprobaciones idénticas escritas a mano y, al aparecer
 * `EN_REVISION`, las cinco habrían seguido dejando editar un mes que se está
 * revisando —cada una en su archivo, sin que nada avisara—. Con una función,
 * añadir un estado se decide una vez y lo heredan todas.
 */
export function esEditable(estado: EstadoPeriodo): boolean {
  return estado === EstadoPeriodo.BORRADOR || estado === EstadoPeriodo.CALCULADO;
}

/** Texto para el mensaje de error de quien intenta tocar un mes bloqueado. */
export const MOTIVO_BLOQUEO: Record<EstadoPeriodo, string> = {
  [EstadoPeriodo.BORRADOR]: '',
  [EstadoPeriodo.CALCULADO]: '',
  [EstadoPeriodo.EN_REVISION]:
    'El periodo está EN REVISIÓN: recházalo primero si hay que corregir algo.',
  [EstadoPeriodo.CERRADO]: 'El periodo está CERRADO: reábrelo para modificarlo.',
  [EstadoPeriodo.PAGADO]:
    'El periodo ya está PAGADO y no se modifica: corrígelo con un ajuste en el mes siguiente.',
};

/** Lo que impide mandar un mes a revisión. Vacío = se puede. */
export interface BloqueoRevision {
  clave: string;
  detalle: string;
}

/**
 * La compuerta: qué tiene que estar resuelto ANTES de que alguien revise.
 *
 * Existe porque un flujo de aprobaciones que deja cerrar un mes con cuarenta
 * filas sin clasificar no protege nada — solo reparte la firma de un número
 * que ya estaba mal. Todos estos datos los calcula `alertas()` desde antes;
 * lo que faltaba era que alguno bloqueara algo.
 *
 * Qué NO bloquea, y es deliberado:
 *
 * - **Las filas excluidas a mano.** Excluir ya exige motivo y queda auditado:
 *   es una decisión tomada, no una tarea pendiente.
 * - **Las vendedoras dadas de baja.** Tampoco es un pendiente, y el informe
 *   declara solo quiénes quedaron fuera.
 */
export function bloqueosParaRevision(alertas: {
  filasSinClasificar: number;
  vendedorasSinConfigurar: number;
  filasSinVendedora: number;
  vendedorasLiquidadas: number;
}): BloqueoRevision[] {
  const bloqueos: BloqueoRevision[] = [];

  if (alertas.vendedorasLiquidadas === 0) {
    bloqueos.push({
      clave: 'SIN_LIQUIDAR',
      detalle: 'El periodo no tiene ninguna liquidación calculada.',
    });
  }

  if (alertas.filasSinClasificar > 0) {
    bloqueos.push({
      clave: 'FILAS_SIN_CLASIFICAR',
      detalle:
        `${alertas.filasSinClasificar} venta(s) sin clasificar: no se sabe con qué tarifa ` +
        'pagan, así que hoy no están comisionando.',
    });
  }

  if (alertas.vendedorasSinConfigurar > 0) {
    bloqueos.push({
      clave: 'VENDEDORAS_SIN_CONFIGURAR',
      detalle:
        `${alertas.vendedorasSinConfigurar} vendedora(s) con ventas del mes pero sin tipo, ` +
        'área ni sueldo: no se les liquidó nada.',
    });
  }

  if (alertas.filasSinVendedora > 0) {
    bloqueos.push({
      clave: 'FILAS_SIN_VENDEDORA',
      detalle:
        `${alertas.filasSinVendedora} venta(s) sin vendedora asignada: su comisión no es ` +
        'de nadie.',
    });
  }

  return bloqueos;
}

/** Una persona habilitada para aprobar el cierre. */
export interface Aprobador {
  id: string;
  nombre: string;
}

export interface EstadoRevision {
  /** SUPER_ADMIN activos AHORA que ya dieron su visto bueno. */
  aprobaron: Array<Aprobador & { comentario: string | null; fecha: Date }>;
  /** SUPER_ADMIN activos AHORA que todavía no. */
  faltan: Aprobador[];
  /** true = no queda nadie por aprobar y hay al menos una aprobación. */
  completa: boolean;
}

/**
 * Quién aprobó, quién falta y si el mes ya se puede cerrar.
 *
 * ## Por qué se evalúa contra los SUPER_ADMIN de AHORA
 *
 * Un SUPER_ADMIN puede bajar a ADMIN en cualquier momento, también con una
 * revisión abierta. Congelar la lista de aprobadores al abrir la revisión deja
 * el mes esperando para siempre la firma de alguien que ya no tiene el rol, y
 * hay que destrabarlo por SQL. Por eso el conjunto exigido se recalcula en cada
 * lectura:
 *
 * - **Baja a ADMIN o se desactiva** → deja de sumar y también de bloquear. Su
 *   aprobación queda en la tabla (fue legítima cuando la dio) pero ya no cuenta.
 * - **Entra un SUPER_ADMIN nuevo** → el mes vuelve a quedar pendiente. Es lo
 *   correcto: no ha visto estas cifras.
 *
 * ## El caso que hay que blindar: cero aprobadores
 *
 * "Todos aprobaron" sobre un conjunto vacío es verdadero, y un mes se cerraría
 * solo sin que nadie lo firmara — justo el día en que se quedaron sin
 * SUPER_ADMIN. De ahí el `aprobaron.length > 0`: sin al menos una firma real no
 * hay cierre, pase lo que pase con los roles.
 */
export function calcularEstadoRevision(
  superAdminsActivos: readonly Aprobador[],
  aprobaciones: ReadonlyArray<{ usuarioId: string; comentario: string | null; createdAt: Date }>,
): EstadoRevision {
  const porUsuario = new Map(aprobaciones.map(a => [a.usuarioId, a]));

  const aprobaron = superAdminsActivos
    .filter(s => porUsuario.has(s.id))
    .map(s => {
      const a = porUsuario.get(s.id)!;
      return { id: s.id, nombre: s.nombre, comentario: a.comentario, fecha: a.createdAt };
    });

  const faltan = superAdminsActivos.filter(s => !porUsuario.has(s.id));

  return { aprobaron, faltan, completa: faltan.length === 0 && aprobaron.length > 0 };
}
