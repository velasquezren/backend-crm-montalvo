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
 * `CRITICA` existe en el contrato y ninguna regla la produce todavía: hace
 * falta un criterio aprobado (una urgencia médica no se detecta con palabras
 * sueltas) y esta fase no usa clasificadores.
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

const ORDEN_MOTIVOS: readonly MotivoAtencion[] = ['SOLICITUD_EXPLICITA', 'SOLICITUD_CITA', 'REVISION'];

/** La prioridad sale del motivo, en un solo sitio. */
export function prioridadDeMotivo(motivo: MotivoAtencion): PrioridadAtencion {
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
}

const ESTADOS_DE_OFERTA_NUESTRA = new Set(['CORRELACIONADA', 'CADUCADA']);

/**
 * Por qué esta respuesta necesita a una persona. Reglas deterministas, sin
 * clasificador:
 *
 * - «Hablar con recepción» de una oferta nuestra → la pidió (aunque la oferta
 *   haya caducado: pedir una persona siempre se atiende).
 * - Flow de cita validado, o «Solicitar cita» → solicitud de cita.
 * - Cualquier otra respuesta, o una sin correlación → revisión. Hoy ninguna
 *   automatización continúa una selección, así que ninguna puede quedar sin
 *   que alguien la vea.
 * - El segundo toque de la misma oferta no crea nada nuevo.
 *
 * El identificador solo cuenta si `guardarRespuesta` lo encontró en la oferta
 * guardada: un payload construido a mano no llega aquí como `seleccionId`.
 */
export function motivoDeRespuesta(r: ResultadoRespuesta): MotivoAtencion | null {
  if (r.estado === 'DUPLICADA') return null;
  const nuestra = ESTADOS_DE_OFERTA_NUESTRA.has(r.estado);
  if (nuestra && r.seleccionId === 'TALK_TO_HUMAN') return 'SOLICITUD_EXPLICITA';
  if (nuestra && (r.seleccionId === 'BOOK_APPOINTMENT' || r.propositoFlow === 'SOLICITUD_CITA')) return 'SOLICITUD_CITA';
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
