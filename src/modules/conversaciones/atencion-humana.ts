import { MotivoAtencion, Prisma } from '../../prisma/prisma-client';

/*
 * Atención humana: cuándo una conversación necesita a una PERSONA, con qué
 * prioridad y en qué estado está. Las definiciones viven aquí una vez, como
 * `estado-conversacion.ts`: el inbox, sus contadores, la ingesta y las
 * transiciones importan de este archivo. Diseño en docs/atencion-humana.md.
 *
 * El estado no tiene columna propia: sale de dos fechas. Una columna `estado`
 * además de las fechas sería una segunda verdad esperando a contradecir a la
 * primera.
 */

export type EstadoAtencion = 'ESPERANDO' | 'EN_ATENCION';

/**
 * `CRITICA` la produce un solo criterio: la paciente DICE que es una emergencia
 * —toca «Es una emergencia» en el menú o escribe, entera, una de las frases de
 * `esAvisoDeEmergencia`—. Es lo que ella declara, no algo que el CRM deduzca: una
 * urgencia descrita con otras palabras no se detecta (ver docs/menu-atencion.md).
 */
export type PrioridadAtencion = 'NORMAL' | 'ALTA' | 'CRITICA';

/** Hay una solicitud viva: en espera o en atención. */
export const CON_ATENCION = { atencionSolicitadaEn: { not: null } } satisfies Prisma.ConversacionWhereInput;
/** Nadie la tomó todavía. */
export const ESPERANDO_HUMANO = { ...CON_ATENCION, atencionTomadaEn: null } satisfies Prisma.ConversacionWhereInput;
/** Alguien la está atendiendo. */
export const EN_ATENCION = { ...CON_ATENCION, atencionTomadaEn: { not: null } } satisfies Prisma.ConversacionWhereInput;

/** Lo que se escribe al resolverla. La pausa de la automatización NO va aquí: resolver no la levanta. */
export const SIN_ATENCION = {
  atencionSolicitadaEn: null,
  atencionMotivo: null,
  atencionMensajeId: null,
  atencionTomadaEn: null,
  atencionTomadaPorId: null,
} satisfies Prisma.ConversacionUncheckedUpdateManyInput;

/**
 * Orden de la pestaña «Atención»: primero lo que nadie tomó, después por
 * prioridad (el orden del enum `MotivoAtencion`) y, a igualdad, la espera más
 * larga primero. Las demás pestañas conservan su orden por `updatedAt`.
 */
export const ORDEN_ATENCION = [
  { atencionTomadaEn: { sort: 'asc', nulls: 'first' } },
  { atencionMotivo: 'asc' },
  { atencionSolicitadaEn: 'asc' },
  { id: 'asc' },
] satisfies Prisma.ConversacionOrderByWithRelationInput[];

/**
 * Clave del candado de Postgres de los automáticos de una conversación
 * (`pg_advisory_xact_lock(hashtextextended(conversacionId, CANDADO))`).
 * La toman quien guarda un automático y quien pausa la automatización: así un
 * automático en curso y una solicitud de atención no se cruzan.
 */
export const CANDADO_AUTOMATICOS = 70071;

const ORDEN_MOTIVOS: readonly MotivoAtencion[] = ['EMERGENCIA', 'SOLICITUD_EXPLICITA', 'SOLICITUD_CITA', 'COMPROBANTE_PAGO', 'REVISION'];

/** La prioridad sale del motivo, en un solo sitio. */
export function prioridadDeMotivo(motivo: MotivoAtencion): PrioridadAtencion {
  if (motivo === 'EMERGENCIA') return 'CRITICA';
  return motivo === 'SOLICITUD_EXPLICITA' ? 'ALTA' : 'NORMAL';
}

/** ¿`nuevo` es más urgente que `actual`? Una solicitud viva solo puede subir. */
export function subeMotivo(actual: MotivoAtencion | null, nuevo: MotivoAtencion): boolean {
  return actual === null || ORDEN_MOTIVOS.indexOf(nuevo) < ORDEN_MOTIVOS.indexOf(actual);
}

export function estadoDeAtencion(c: { atencionSolicitadaEn: Date | null; atencionTomadaEn: Date | null }): EstadoAtencion | null {
  if (!c.atencionSolicitadaEn) return null;
  return c.atencionTomadaEn ? 'EN_ATENCION' : 'ESPERANDO';
}

/** Lo que `guardarRespuesta` concluyó de una respuesta interactiva. */
export interface ResultadoRespuesta {
  /** `CORRELACIONADA`, `CADUCADA`, `DUPLICADA`, `NO_CORRELACIONADA`, `INVALIDA`, `DESCONOCIDA`. */
  estado: string;
  /** Solo si la opción estaba en NUESTRA oferta, para este paciente y esta conversación. */
  seleccionId?: string;
  /** Solo si el Flow se validó contra la oferta y su versión. */
  propositoFlow?: string;
  /** La opción estaba en una oferta del menú de atención (ver `OfertaInteraccion.origen`). */
  deMenu?: boolean;
  /** La opción estaba en la tarjeta de esta promoción. */
  promocionId?: string;
}

const ESTADOS_DE_OFERTA_NUESTRA = new Set(['CORRELACIONADA', 'CADUCADA']);

/**
 * Por qué esta respuesta necesita a una persona. Reglas deterministas, sin
 * clasificador:
 *
 * - «Es una emergencia» de una oferta nuestra → emergencia (aunque haya caducado).
 * - «Hablar con recepción» de una oferta nuestra → la pidió (aunque la oferta
 *   haya caducado: pedir una persona siempre se atiende).
 * - Flow de cita validado (solicitud o reserva), o «Solicitar cita» → solicitud de cita.
 * - Una opción que el menú de atención contesta solo (`resueltaSola`: horarios,
 *   ubicación, la lista de promociones) → nada: ya tiene respuesta.
 * - Cualquier otra respuesta, o una sin correlación → revisión: ninguna queda sin
 *   que alguien la vea.
 * - El segundo toque de la misma oferta no crea nada nuevo.
 *
 * El identificador solo cuenta si `guardarRespuesta` lo encontró en la oferta
 * guardada: un payload construido a mano no llega aquí como `seleccionId`.
 */
export function motivoDeRespuesta(r: ResultadoRespuesta, resueltaSola = false): MotivoAtencion | null {
  if (r.estado === 'DUPLICADA') return null;
  const nuestra = ESTADOS_DE_OFERTA_NUESTRA.has(r.estado);
  if (nuestra && r.seleccionId === 'EMERGENCY') return 'EMERGENCIA';
  if (nuestra && r.seleccionId === 'TALK_TO_HUMAN') return 'SOLICITUD_EXPLICITA';
  /* Solo una oferta VIGENTE se contesta sola: un toque tardío lo ve una persona. */
  if (resueltaSola && r.estado === 'CORRELACIONADA') return null;
  /* Una reserva hecha por el Flow también: recepción la tiene que confirmar en FileMaker. */
  if (nuestra && (r.seleccionId === 'BOOK_APPOINTMENT' || r.propositoFlow === 'SOLICITUD_CITA' || r.propositoFlow === 'RESERVA_CITA')) return 'SOLICITUD_CITA';
  return 'REVISION';
}

/**
 * Registra (o sube) la solicitud y pausa la automatización, DENTRO de la
 * transacción de la ingesta y bajo el candado de los automáticos.
 *
 * - Sin solicitud viva: nace con el reloj en `ahora`.
 * - Con una viva: solo sube el motivo; la hora de inicio y quién la tomó no se
 *   tocan. Recargar, un webhook repetido o un segundo toque no mueven el reloj.
 *
 * Devuelve si nació una solicitud nueva.
 */
export async function registrarSolicitudAtencion(
  tx: Prisma.TransactionClient,
  conversacionId: string,
  motivo: MotivoAtencion,
  mensajeId: string,
  ahora: Date,
): Promise<boolean> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${conversacionId}, ${CANDADO_AUTOMATICOS}))::text`;
  const actual = await tx.conversacion.findUniqueOrThrow({
    where: { id: conversacionId },
    select: { atencionSolicitadaEn: true, atencionMotivo: true, automatizacionPausadaEn: true },
  });
  const nueva = !actual.atencionSolicitadaEn;
  const sube = nueva || subeMotivo(actual.atencionMotivo, motivo);
  await tx.conversacion.update({
    where: { id: conversacionId },
    data: {
      ...(nueva ? { atencionSolicitadaEn: ahora, atencionTomadaEn: null, atencionTomadaPorId: null } : {}),
      ...(sube ? { atencionMotivo: motivo, atencionMensajeId: mensajeId } : {}),
      ...(actual.automatizacionPausadaEn ? {} : { automatizacionPausadaEn: ahora }),
    },
  });
  return nueva;
}

/* ── Pedir una persona escribiendo ──────────────────────────────────── */

/**
 * Frases COMPLETAS con las que una paciente pide a una persona. Cuenta solo si
 * el mensaje entero es una de ellas —con los saludos y cortesías de siempre—:
 * «quiero hablar con una persona» sí; «no quiero hablar con una persona que me
 * cobre más» no, y «hablar con recepción sobre mi cita del martes» tampoco.
 *
 * Esto NO detecta urgencias ni asuntos médicos y no pretende hacerlo: lo que no
 * esté en esta lista cerrada no genera solicitud. Ver «Antes de activar la IA»
 * en docs/atencion-humana.md.
 */
/** Saludo y cortesía con que puede empezar una frase entera. */
const SALUDO = '(?:(?:hola|buenas|buenos dias|buenas tardes|buenas noches)\\s+)?(?:por favor\\s+)?';
const CORTESIA = '(?:\\s+por\\s+favor)?$';

const PEDIR_PERSONA = new RegExp(
  `^${SALUDO}` +
  '(?:(?:quiero|quisiera|necesito|deseo|me gustaria|puedo|podria|podrian|podemos)\\s+)?' +
  '(?:hablar|comunicarme|contactar|chatear)\\s+con\\s+' +
  '(?:un[ao]?\\s+persona(?:\\s+real)?|alguien(?:\\s+de\\s+la\\s+clinica)?|un\\s+humano|un\\s+asesor|una\\s+asesora|' +
  'un\\s+operador|una\\s+operadora|un\\s+agente|una\\s+agente|(?:la\\s+)?recepcion|(?:la|una)\\s+recepcionista)' +
  CORTESIA,
);

function sinAdornos(texto: string): string {
  return texto
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[¿?¡!.,;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** ¿Lo que escribió, entero, es una de las frases de pedir a una persona? */
export function esPedidoDePersona(texto: string): boolean {
  return texto.length <= 120 && PEDIR_PERSONA.test(sinAdornos(texto));
}

/**
 * Frases COMPLETAS con las que una paciente dice que es una emergencia. Mismo
 * criterio que `PEDIR_PERSONA`: el mensaje entero, con saludos y cortesías.
 * «es una emergencia» sí; «no es una emergencia, solo una consulta» no.
 *
 * Una PREGUNTA no es un aviso: «¿hay emergencia?» suele preguntar si la clínica
 * tiene ese servicio, y «¿es urgente?», si conviene ir hoy. Con «¿» o «?» no cuenta.
 *
 * Es lo que ella declara, no una detección: «me siento muy mal» o «sangro» no
 * están aquí ni deben agregarse sin un criterio aprobado por la clínica. Ante la
 * duda una persona lo ve en la bandeja, como siempre.
 */
const AVISO_EMERGENCIA = [
  new RegExp(`^${SALUDO}(?:(?:es|tengo|tenemos|hay)\\s+)?(?:una\\s+)?(?:emergencia|urgencia)(?:\\s+medica)?${CORTESIA}`),
  new RegExp(`^${SALUDO}(?:es\\s+)?(?:muy\\s+)?urgente${CORTESIA}`),
  new RegExp(`^(?:auxilio|socorro|ayuda urgente)${CORTESIA}`),
];

/** ¿Lo que escribió, entero, es una de las frases de emergencia? */
export function esAvisoDeEmergencia(texto: string): boolean {
  if (texto.length > 120 || /[¿?]/.test(texto)) return false;
  const limpio = sinAdornos(texto);
  return AVISO_EMERGENCIA.some(r => r.test(limpio));
}

/* ── Contexto del traspaso ──────────────────────────────────────────── */

/** Un dato que la paciente eligió en un Flow aprobado, ya con su etiqueta. */
export interface DatoDeFlow {
  etiqueta: string;
  valor: string;
}

/**
 * Lo que recepción necesita saber sin leer todo el chat. Determinista: solo
 * datos que existen —el motivo, lo que se le ofreció, lo que eligió, su
 * último mensaje—. Nada generado y ningún resumen médico.
 */
export interface ContextoAtencion {
  estado: EstadoAtencion;
  motivo: MotivoAtencion;
  prioridad: PrioridadAtencion;
  solicitadaEn: Date;
  tomadaEn: Date | null;
  tomadaPor: { id: string; nombre: string } | null;
  /** La respuesta interactiva que la originó. */
  origen: {
    /** `seleccion`, `respuesta_flow` o `error` (no se pudo interpretar). */
    tipo: string;
    /** El título de la opción, o la descripción del formulario. */
    cuerpo: string;
    recibidoEn: Date;
    datos: DatoDeFlow[];
    versionFlow: string | null;
    /** Lo que de verdad se le había enviado: el texto y los títulos de las opciones. */
    ofrecido: { cuerpo: string; opciones: string[] } | null;
  } | null;
  /** Lo último que escribió, si no es la propia respuesta que la originó. */
  ultimoMensaje: { contenido: string; createdAt: Date } | null;
}

function comoObjeto(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function texto(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function datosDeVista(v: unknown): DatoDeFlow[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap(d => {
    const o = comoObjeto(d);
    const etiqueta = texto(o?.['etiqueta']);
    const valor = texto(o?.['valor']);
    return etiqueta && valor ? [{ etiqueta, valor }] : [];
  });
}

/**
 * Arma el contexto. Solo se llama después de comprobar que quien pregunta
 * puede ver la conversación, y TODO se lee acotado a ella: ni el mensaje de
 * origen ni la oferta pueden venir de otro chat aunque un id apuntara allí.
 * Lee la proyección `vista` que ya construyó el servidor, nunca el original
 * cifrado.
 */
export async function contextoDeAtencion(
  db: Prisma.TransactionClient,
  conversacionId: string,
  c: {
    atencionSolicitadaEn: Date | null;
    atencionMotivo: MotivoAtencion | null;
    atencionMensajeId: string | null;
    atencionTomadaEn: Date | null;
    atencionTomadaPor: { id: string; nombre: string } | null;
  },
): Promise<ContextoAtencion | null> {
  const estado = estadoDeAtencion(c);
  if (!estado || !c.atencionSolicitadaEn || !c.atencionMotivo) return null;

  const [origen, ultimo] = await Promise.all([
    c.atencionMensajeId
      ? db.mensaje.findFirst({
          where: { id: c.atencionMensajeId, conversacionId },
          select: { id: true, createdAt: true, interaccion: { select: { vista: true } } },
        })
      : null,
    db.mensaje.findFirst({
      where: { conversacionId, direccion: 'ENTRANTE' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, contenido: true, createdAt: true },
    }),
  ]);

  const vista = comoObjeto(origen?.interaccion?.vista);
  const contextoId = texto(vista?.['contextoId']);
  const oferta = contextoId
    ? await db.mensaje.findFirst({
        where: { id: contextoId, conversacionId, direccion: 'SALIENTE' },
        select: { interaccion: { select: { vista: true } } },
      })
    : null;
  const vistaOferta = comoObjeto(oferta?.interaccion?.vista);
  const opciones = Array.isArray(vistaOferta?.['opciones'])
    ? (vistaOferta['opciones'] as unknown[]).flatMap(o => {
        const titulo = texto(comoObjeto(o)?.['titulo']);
        return titulo ? [titulo] : [];
      })
    : [];

  return {
    estado,
    motivo: c.atencionMotivo,
    prioridad: prioridadDeMotivo(c.atencionMotivo),
    solicitadaEn: c.atencionSolicitadaEn,
    tomadaEn: c.atencionTomadaEn,
    tomadaPor: c.atencionTomadaPor,
    origen: origen && vista
      ? {
          tipo: texto(vista['tipo']) ?? 'error',
          cuerpo: texto(vista['cuerpo']) ?? '',
          recibidoEn: origen.createdAt,
          datos: datosDeVista(vista['datos']),
          versionFlow: texto(vista['versionFlow']),
          ofrecido: vistaOferta ? { cuerpo: texto(vistaOferta['cuerpo']) ?? '', opciones } : null,
        }
      : null,
    ultimoMensaje: ultimo && ultimo.id !== origen?.id ? { contenido: ultimo.contenido, createdAt: ultimo.createdAt } : null,
  };
}

/* ── Resolución: quién, cuándo y cuánto esperó ──────────────────────── */

/**
 * La solicitud que está viva, leída con la fila bloqueada: nadie la cambia entre leerla y
 * resolverla. `NO KEY UPDATE` y no `UPDATE`: es el bloqueo que ya toma un UPDATE normal, y no
 * frena a un mensaje entrante que se inserta mientras tanto (su llave foránea pide `KEY SHARE`).
 */
export interface SolicitudViva {
  solicitadaEn: Date;
  motivo: MotivoAtencion;
  tomadaEn: Date | null;
  tomadaPorId: string | null;
}

export async function bloquearSolicitudViva(tx: Prisma.TransactionClient, conversacionId: string): Promise<SolicitudViva | null> {
  const filas = await tx.$queryRaw<SolicitudViva[]>`
    SELECT "atencionSolicitadaEn" AS "solicitadaEn", "atencionMotivo" AS "motivo",
           "atencionTomadaEn" AS "tomadaEn", "atencionTomadaPorId" AS "tomadaPorId"
    FROM "Conversacion"
    WHERE id = ${conversacionId} AND "atencionSolicitadaEn" IS NOT NULL
    FOR NO KEY UPDATE`;
  return filas[0] ?? null;
}

/**
 * Deja constancia de que una solicitud terminó, en la MISMA transacción que la
 * borra de la conversación: si la bitácora no se escribe, la solicitud tampoco
 * se resuelve. La conversación solo guarda la solicitud viva, así que esta fila
 * de `AuditLog` es el único registro de cuánto esperó y de quién la atendió.
 *
 * `via` distingue «Resolver» de cerrar el chat con la solicitud todavía viva.
 */
export async function auditarResolucion(
  tx: Prisma.TransactionClient,
  conversacionId: string,
  usuarioId: string,
  viva: SolicitudViva,
  via: 'RESOLVER' | 'CIERRE',
  resueltaEn: Date,
): Promise<void> {
  const segundos = (desde: Date, hasta: Date) => Math.max(0, Math.round((hasta.getTime() - desde.getTime()) / 1000));
  await tx.auditLog.create({
    data: {
      entidad: 'Conversacion',
      entidadId: conversacionId,
      accion: 'ATENCION_RESUELTA',
      usuarioId,
      cambios: {
        via,
        motivo: viva.motivo,
        solicitadaEn: viva.solicitadaEn.toISOString(),
        tomadaEn: viva.tomadaEn?.toISOString() ?? null,
        tomadaPorId: viva.tomadaPorId,
        resueltaEn: resueltaEn.toISOString(),
        esperaSegundos: segundos(viva.solicitadaEn, viva.tomadaEn ?? resueltaEn),
        atencionSegundos: viva.tomadaEn ? segundos(viva.tomadaEn, resueltaEn) : null,
      },
    },
  });
}
