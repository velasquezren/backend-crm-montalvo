import { Prisma } from '../../prisma/prisma-client';

import { terminoBusqueda } from '../../common/dto/busqueda';
import { SELECT_LINEA } from './acceso-conversacion';
import { TabInbox } from './dto/query-conversaciones.dto';

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
export function whereTab(tab: TabInbox | undefined, usuarioId: string): Prisma.ConversacionWhereInput | undefined {
  switch (tab) {
    case 'SIN_ASIGNAR':
      return { agenteId: null };
    case 'MIS_CHATS':
      return { agenteId: usuarioId };
    case 'SIN_RESPONDER':
      return { esperandoRespuesta: true };
    default:
      return undefined;
  }
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

/** Filtro del admin por agente asignado (solo aplica en la pestaña TODAS). */
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
  mensajes: {
    /* `automatico` viaja aunque el listado no lo pinte: es lo que permite
       al inbox distinguir "ya le contestó alguien" de "solo salió el
       acuse fuera de horario". */
    select: {
      id: true,
      contenido: true,
      direccion: true,
      estadoEnvio: true,
      codigoErrorEnvio: true,
      tipo: true,
      automatico: true,
      createdAt: true,
      /* La fila del inbox pinta el nombre del archivo para un DOCUMENTO
         (`ultimo.mediaNombre || ultimo.contenido || 'Documento'`) y este select
         no lo traía: la vista previa caía SIEMPRE al respaldo y la agente veía
         "Documento" a secas en vez de "resultados-laboratorio.pdf". No lo
         detectaba nada porque el campo es opcional en el modelo del frontend —
         `undefined` es un valor válido, no un error. */
      mediaNombre: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 1,
  },
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
export type ConversacionDeInbox = Omit<FilaCruda, '_count'> & {
  agente: { id: string; nombre: string } | null;
  noLeidosCount: number;
};

/** Los números de las cuatro pestañas del inbox. */
export interface ContadoresInbox {
  total: number;
  sinAsignar: number;
  misChats: number;
  sinResponder: number;
}

/**
 * Normaliza una fila cruda: expone el contador de no leídos con nombre propio y
 * resuelve el agente mostrado.
 *
 * El `?? cliente.agente` no es cosmético: una conversación del pool que atiende
 * cualquiera sigue perteneciendo a la dueña de la paciente, y es la razón por la
 * que `whereVisibilidad` la deja ver. Sin esta línea, la fila aparecería como
 * "sin asignar" para quien sí es su dueña.
 */
export function aFilaDeInbox(fila: FilaCruda): ConversacionDeInbox {
  const { _count, ...resto } = fila;
  return {
    ...resto,
    cliente: fila.linea.comercial ? fila.cliente : { ...fila.cliente, agente: null },
    agente: fila.agente ?? (fila.linea.comercial ? fila.cliente?.agente : null) ?? null,
    noLeidosCount: _count.mensajes,
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
