import { Prisma } from '../../prisma/prisma-client';

import { terminoBusqueda } from '../../common/dto/busqueda';
import { SELECT_LINEA, whereAccesoConversacion } from './acceso-conversacion';
import { QueryConversacionesDto, TabInbox } from './dto/query-conversaciones.dto';
import { ABIERTA, SIN_RESPONDER } from './estado-conversacion';

/*
 * Las piezas de consulta del inbox: filtros (`where`), columnas de una fila y
 * su forma final. Son funciones puras sin acceso a la base, así que viven fuera
 * de `ConversacionesService` —que las compone en `findAll`,
 * `contadoresInbox` y `resumenParaInbox`— y se pueden leer sin recorrer el
 * envío de mensajes ni las plantillas.
 *
 * El permiso (quién puede ver qué conversación) NO está aquí: es
 * `whereAccesoConversacion`, en `acceso-conversacion.ts`. Lo de este archivo son
 * preferencias de vista que se combinan con él por AND y nunca lo amplían.
 */

/**
 * Filtro "Solo míos" del inbox: asignadas a mí o sin dueño.
 *
 * **Es una preferencia de vista, no un permiso**, y por eso vive aparte de
 * `whereVisibilidad`. Los dos se combinan con AND: el permiso acota lo que el
 * usuario PUEDE ver y este acota lo que QUIERE ver ahora.
 *
 * Estaban fundidos en un solo parámetro y salió caro: para que el interruptor
 * del admin dijera "míos o del pool" se le quitó a `whereVisibilidad` la rama
 * de `cliente.agenteId`, y eso le recortó en silencio lo que ve toda agente
 * normal. Un cambio de UI no puede poder cambiar quién ve los datos de qué
 * paciente; separados, no vuelve a pasar.
 */
export function whereSoloMios(usuarioId: string): Prisma.ConversacionWhereInput {
  return { OR: [{ agenteId: usuarioId }, { agenteId: null }] };
}

/**
 * La pestaña activa, traducida a SQL.
 *
 * Las cuatro se resolvían en el navegador sobre las conversaciones ya cargadas,
 * que es exactamente lo que obligaba a cargarlas todas. `SIN_RESPONDER` es la
 * única que no se puede expresar con los datos de la propia fila —depende del
 * ÚLTIMO mensaje— y por eso `Conversacion.esperandoRespuesta` existe.
 *
 * Igual que `whereSoloMios`, esto es **preferencia de vista, no permiso**: se
 * combina con AND sobre `whereVisibilidad` y jamás lo amplía.
 */
export function whereTab(
  tab: TabInbox | undefined,
  usuarioId: string,
  conBusqueda = false,
): Prisma.ConversacionWhereInput | undefined {
  switch (tab) {
    case 'SIN_ASIGNAR':
      return { ...ABIERTA, agenteId: null };
    case 'MIS_CHATS':
      return { ...ABIERTA, agenteId: usuarioId };
    case 'SIN_RESPONDER':
      return SIN_RESPONDER;
    case 'CERRADAS':
      return { cerradaEn: { not: null } };
    default:
      /* «Todas» son las abiertas... salvo cuando se BUSCA: quien busca a una
         paciente quiere encontrarla, esté su chat abierto o cerrado. */
      return conBusqueda ? undefined : ABIERTA;
  }
}

/**
 * El ALCANCE de la vista: permiso + preferencias que acotan a QUIÉN se mira
 * (solo míos, una agente, una línea). Lo comparten la lista y los contadores
 * de las pestañas, así que no pueden divergir.
 *
 * Divergían: la lista aplicaba el filtro de agente y el contador no, y con un
 * admin mirando los chats de una agente las pestañas seguían contando las de
 * todas.
 */
export function whereAlcanceInbox(
  query: QueryConversacionesDto,
  soloAgenteId: string | undefined,
  usuarioId: string,
): Prisma.ConversacionWhereInput | undefined {
  return combinar(
    whereAccesoConversacion(soloAgenteId),
    query.soloMios ? whereSoloMios(usuarioId) : undefined,
    whereAgente(query.agenteId),
    query.lineaId ? { lineaId: query.lineaId } : undefined,
    query.categoria ? { cliente: { categoria: query.categoria } } : undefined,
  );
}

/**
 * Lo que se LISTA: el alcance más la pestaña y la búsqueda. Una sola
 * definición para el listado y para la fila del tiempo real: si difirieran, una
 * conversación aparecería al refrescar pero no al recargar, o al revés.
 */
export function whereVistaInbox(
  query: QueryConversacionesDto,
  soloAgenteId: string | undefined,
  usuarioId: string,
): Prisma.ConversacionWhereInput | undefined {
  return combinar(
    whereAlcanceInbox(query, soloAgenteId, usuarioId),
    whereTab(query.tab, usuarioId, Boolean(terminoBusqueda(query.busqueda))),
    whereBusqueda(query.busqueda),
  );
}

/** Los contadores de las pestañas sobre un alcance: mismas condiciones que `whereTab`. */
export function wherePestanas(usuarioId: string) {
  return {
    total: ABIERTA,
    sinAsignar: whereTab('SIN_ASIGNAR', usuarioId)!,
    misChats: whereTab('MIS_CHATS', usuarioId)!,
    sinResponder: whereTab('SIN_RESPONDER', usuarioId)!,
    cerradas: whereTab('CERRADAS', usuarioId)!,
  } satisfies Record<keyof ContadoresInbox, Prisma.ConversacionWhereInput>;
}

/**
 * Buscador del inbox: nombre o teléfono de la paciente, sobre el conjunto
 * COMPLETO.
 *
 * Antes esto vivía en el navegador y solo veía las 500 cargadas, así que buscar
 * a una paciente con un chat antiguo devolvía cero y la agente concluía que no
 * existía. Los dos `contains` van contra los índices GIN trigram que ya tiene
 * `Cliente` (`Cliente_nombre_trgm_idx`, `Cliente_telefono_trgm_idx`).
 *
 * El teléfono no lleva `mode: 'insensitive'` a propósito: son dígitos, y pedir
 * insensibilidad a mayúsculas ahí solo descarta el uso del índice.
 *
 * Pasa por `terminoBusqueda()` como todo buscador del backend: Prisma traduce
 * `contains` a `LIKE '%…%'` **sin escapar**, así que teclear `%` devolvería el
 * inbox entero y `20%` haría match con cualquier "20".
 */
export function whereBusqueda(texto: string | undefined): Prisma.ConversacionWhereInput | undefined {
  const q = terminoBusqueda(texto);
  if (!q) return undefined;
  return {
    cliente: {
      OR: [
        { nombre: { contains: q, mode: 'insensitive' } },
        { telefono: { contains: q } },
        { pac: { contains: q, mode: 'insensitive' } },
        { ci: { contains: q, mode: 'insensitive' } },
      ],
    },
  };
}

/**
 * Filtro del admin por agente asignado. Es ALCANCE (va en `whereAlcanceInbox`):
 * acota todas las pestañas y sus contadores, no solo «Todas». El frontend lo
 * soltaba al cambiar de pestaña, y el número de «Sin responder» con una agente
 * elegida no era lo que aparecía al pulsarla.
 */
export function whereAgente(agenteId: string | undefined): Prisma.ConversacionWhereInput | undefined {
  return agenteId ? { agenteId } : undefined;
}

/**
 * Las columnas de una fila del inbox, en un solo sitio.
 *
 * Lo usan el listado (`findAll`) y el refresco de una sola fila por WebSocket
 * (`resumenParaInbox`). Estaban destinados a divergir si se escribían dos veces,
 * y una fila del inbox con menos campos que sus vecinas se ve como un bug de
 * pintado, no como dos `select` distintos.
 */
export const SELECT_INBOX = {
  id: true,
  linea: { select: SELECT_LINEA },
  updatedAt: true,
  esperandoRespuesta: true,
  /* Para marcar «Cerrada» en una fila que trajo la búsqueda. */
  cerradaEn: true,
  cliente: {
    select: {
      id: true,
      nombre: true,
      telefono: true,
      categoria: true,
      pac: true,
      ci: true,
      agente: { select: { id: true, nombre: true } },
    },
  },
  agente: { select: { id: true, nombre: true } },
  _count: {
    select: {
      mensajes: {
        where: { direccion: 'ENTRANTE' as const, leidoEn: null },
      },
    },
  },
} satisfies Prisma.ConversacionSelect;

export type FilaCruda = Prisma.ConversacionGetPayload<{ select: typeof SELECT_INBOX }>;

/** Una fila del inbox tal como la consume el frontend. */
export type MensajeDeInbox = Pick<Prisma.MensajeGetPayload<Record<string, never>>,
  'id' | 'contenido' | 'direccion' | 'estadoEnvio' | 'codigoErrorEnvio' | 'tipo' | 'automatico' | 'createdAt' | 'mediaNombre'>;

export type ConversacionDeInbox = Omit<FilaCruda, '_count'> & { noLeidosCount: number; mensajes: MensajeDeInbox[] };

/** Los números de las cuatro pestañas del inbox. */
export interface ContadoresInbox {
  /** Abiertas. */
  total: number;
  sinAsignar: number;
  misChats: number;
  sinResponder: number;
  cerradas: number;
}

/**
 * Normaliza una fila cruda: expone el contador de no leídos con nombre propio.
 *
 * `agente` es quien ATIENDE el chat (`Conversacion.agenteId`) y nada más. La
 * dueña de la paciente (su cartera) viaja aparte, en `cliente.agente`, y solo
 * en líneas comerciales.
 *
 * Hasta el 2026-09-30 un chat libre mostraba como `agente` a la dueña de la
 * paciente. La fila decía «Ana» mientras el chat estaba en «Sin asignar», no
 * salía al filtrar por Ana, y cualquiera podía contestarlo y quedárselo: la
 * etiqueta afirmaba un responsable que no existía. Además el envío optimista
 * del navegador, al ver un `agente`, no reflejaba que quien contestó se lo
 * había quedado. Ver `crm-conversaciones`, «Quién atiende y de quién es la
 * paciente».
 */
export function aFilaDeInbox(fila: FilaCruda, ultimo?: MensajeDeInbox): ConversacionDeInbox {
  const { _count, ...resto } = fila;
  return {
    ...resto,
    cliente: fila.linea.comercial ? fila.cliente : { ...fila.cliente, agente: null },
    noLeidosCount: _count.mensajes,
    mensajes: ultimo ? [ultimo] : [],
  };
}

/** Combina filtros opcionales con AND; `undefined` si no hay ninguno. */
export function combinar(
  ...filtros: (Prisma.ConversacionWhereInput | undefined)[]
): Prisma.ConversacionWhereInput | undefined {
  const activos = filtros.filter((f): f is Prisma.ConversacionWhereInput => f !== undefined);
  if (activos.length === 0) return undefined;
  return activos.length === 1 ? activos[0] : { AND: activos };
}
