import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, TipoMensaje } from '@prisma/client';

import { CacheMemoria } from '../../common/cache/cache-memoria';
import { escaparComodinesLike, terminoBusqueda } from '../../common/dto/busqueda';
import { calcularPaginacion, paginar, RespuestaPaginada } from '../../common/dto/pagination.dto';
import { R2Service } from '../../common/storage/r2.service';
import { WhatsappCloudService } from '../../common/whatsapp/whatsapp-cloud.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientesService } from '../clientes/clientes.service';
import { ConversacionesGateway } from './conversaciones.gateway';
import { DespachadorSalienteService } from './despachador-saliente.service';
import { QueryConversacionesDto, TabInbox } from './dto/query-conversaciones.dto';

/** Mensajes que trae el detalle inicial de una conversación (más recientes primero, luego se reordenan).
 *  Se acota a 50 para máxima velocidad inicial; los anteriores se cargan por cursor al hacer scroll. */
const LIMITE_MENSAJES_DETALLE = 50;

/**
 * Conversaciones por página del inbox.
 *
 * Sustituye al viejo `LIMITE_INBOX = 500`, que **no era paginación sino un
 * corte**: el frontend resolvía pestañas, filtro por agente y buscador en
 * memoria sobre lo recibido, así que una conversación fuera del tope no estaba
 * "en la página siguiente" — no existía para la interfaz, tampoco al buscar a
 * esa paciente por nombre. Ya había pasado al cruzar las 100 (siete chats
 * desaparecidos sin que nada lo dijera) y volvía a pasar al cruzar las 500,
 * proyectado para el 8 de septiembre de 2026 al ritmo medido de +13,3/día.
 *
 * Ahora las cuatro operaciones viven en Postgres (ver `findAll`), así que este
 * número ya no decide qué se puede encontrar, solo cuánto viaja por página.
 *
 * 50 y no los 25 por defecto de `PaginationDto` porque acá lo caro es el viaje,
 * no los bytes: ~155 bytes por conversación son ~7,7 kB por página contra los
 * ~190 ms que cuesta cada ida y vuelta desde Bolivia (ver `crm-rendimiento`).
 * Duplicar la página para partir a la mitad los "cargar más" sale a cuenta.
 */
const POR_PAGINA_INBOX = 50;

/* Estas dos cachés guardan un único valor cada una, así que la clave es
   simbólica: existe porque `CacheMemoria` está pensada para varias entradas. */
const CLAVE_AGENTES = 'activos';
const CLAVE_PLANTILLAS = 'aprobadas';

/** Forma cruda de una plantilla en la respuesta de Meta (solo lo que usamos). */
interface PlantillaMeta {
  name: string;
  status: string;
  category: string;
  language: string;
  components?: Array<{ type: string; text?: string }>;
}

/** Plantilla aprobada, simplificada para el selector del inbox. */
export interface PlantillaResumen {
  nombre: string;
  idioma: string;
  categoria: string;
  cuerpo: string;
  variables: number;
}

/**
 * Módulo Conversaciones — RF-09/RF-10.
 * CRUD + lectura del inbox, mensajería saliente del agente (enviar, plantillas,
 * marcar leído, ticks de entrega) y asignación. Si WHATSAPP_TOKEN y
 * WHATSAPP_PHONE_ID están en .env, envía los mensajes por Meta Cloud API.
 *
 * La entrada de mensajes del webhook (`procesarEntrante` y todo lo que dispara)
 * vive en `IngestaWhatsappService`, separado a propósito: es un pipeline con
 * reglas de idempotencia y concurrencia propias del webhook, no algo que un
 * agente dispare navegando el inbox. Ver el comentario de esa clase.
 */
/** Lo mínimo que el filtro de conversaciones necesita de un agente. */
export interface AgenteResumen {
  id: string;
  nombre: string;
}

/**
 * Visibilidad por rol de una conversación, en UN solo sitio.
 *
 * Un AGENTE ve: las suyas, las de sus clientes, y las que no tiene nadie (pool).
 * De ADMIN para arriba `soloAgenteId` llega `undefined` y se ve todo.
 *
 * Están las dos formas —consulta y chequeo en memoria— juntas a propósito: el
 * listado filtraba también por `cliente.agenteId` pero el detalle solo miraba
 * `conversacion.agenteId`, así que había chats que el agente veía en la lista y
 * daban 404 al abrirlos. Es la misma lección que `alcanceAgente()`: dos copias
 * de la misma regla en sitios distintos terminan divergiendo. Si cambias una,
 * cambias la otra — están pegadas para que se note.
 */
function whereVisibilidad(soloAgenteId?: string): Prisma.ConversacionWhereInput | undefined {
  if (!soloAgenteId) return undefined;
  return {
    OR: [
      { agenteId: soloAgenteId },
      { agenteId: null },
      /* Sus pacientes, aunque otra agente haya contestado el chat.
         `enviarMensaje` reclama la conversación del pool para quien responde,
         pero NO mueve `Cliente.agenteId`: sin esta rama, que una compañera
         conteste una vez le quita a la dueña de la paciente el chat de su
         propia paciente — y con él el seguimiento y la comisión. */
      { cliente: { agenteId: soloAgenteId } },
    ],
  };
}

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
function whereSoloMios(usuarioId: string): Prisma.ConversacionWhereInput {
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
function whereTab(tab: TabInbox | undefined, usuarioId: string): Prisma.ConversacionWhereInput | undefined {
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
function whereBusqueda(texto: string | undefined): Prisma.ConversacionWhereInput | undefined {
  const q = terminoBusqueda(texto);
  if (!q) return undefined;
  return {
    cliente: {
      OR: [{ nombre: { contains: q, mode: 'insensitive' } }, { telefono: { contains: q } }],
    },
  };
}

/** Filtro del admin por agente asignado (solo aplica en la pestaña TODAS). */
function whereAgente(agenteId: string | undefined): Prisma.ConversacionWhereInput | undefined {
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
const SELECT_INBOX = {
  id: true,
  updatedAt: true,
  esperandoRespuesta: true,
  cliente: {
    select: {
      id: true,
      nombre: true,
      telefono: true,
      categoria: true,
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
      tipo: true,
      automatico: true,
      createdAt: true,
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

type FilaCruda = Prisma.ConversacionGetPayload<{ select: typeof SELECT_INBOX }>;

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
function aFilaDeInbox(fila: FilaCruda): ConversacionDeInbox {
  const { _count, ...resto } = fila;
  return {
    ...resto,
    agente: fila.agente ?? fila.cliente?.agente ?? null,
    noLeidosCount: _count.mensajes,
  };
}

/** Combina filtros opcionales con AND; `undefined` si no hay ninguno. */
function combinar(
  ...filtros: (Prisma.ConversacionWhereInput | undefined)[]
): Prisma.ConversacionWhereInput | undefined {
  const activos = filtros.filter((f): f is Prisma.ConversacionWhereInput => f !== undefined);
  if (activos.length === 0) return undefined;
  return activos.length === 1 ? activos[0] : { AND: activos };
}

/** Tipo de mensaje a partir del MIME del archivo subido por el agente. */
function tipoSegunMime(mime: string | undefined): TipoMensaje {
  if (!mime) return 'DOCUMENTO';
  if (mime.startsWith('image/')) return 'IMAGEN';
  if (mime.startsWith('video/')) return 'VIDEO';
  if (mime.startsWith('audio/')) return 'AUDIO';
  return 'DOCUMENTO';
}

/** Contraparte en memoria de `whereVisibilidad`, para las lecturas por ID. */
function puedeVerConversacion(
  conversacion: { agenteId: string | null; cliente?: { agenteId?: string | null } | null },
  soloAgenteId?: string,
): boolean {
  if (!soloAgenteId) return true;
  return (
    conversacion.agenteId === soloAgenteId ||
    conversacion.agenteId === null ||
    conversacion.cliente?.agenteId === soloAgenteId
  );
}

@Injectable()
export class ConversacionesService {
  private readonly logger = new Logger(ConversacionesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clientesService: ClientesService,
    private readonly gateway: ConversacionesGateway,
    private readonly r2: R2Service,
    private readonly whatsapp: WhatsappCloudService,
    private readonly despachador: DespachadorSalienteService,
  ) {}

  /** Dropdown de asignación del admin: cambia solo al dar de alta o baja a alguien. */
  private readonly cacheAgentes = new CacheMemoria<AgenteResumen[]>({
    ttlMs: 30_000,
    maxEntradas: 1,
  });

  /**
   * Plantillas aprobadas de la WABA. 1 hora porque el dato vive en Meta —
   * aprobar una plantilla es un trámite de horas, no de segundos— y cada
   * consulta es un round-trip real contra su API.
   *
   * Antes eran 10 min. Medido en producción el 2026-08-22: con esa ventana,
   * esta consulta salía en vivo ~6 veces por hora y tardaba 400-1123 ms cada
   * vez; al caer en la misma ráfaga de peticiones con la que un agente abre
   * el inbox (junto a /conversaciones, /kpis/resumen, etc.), esas ventanas
   * mostraban además latencia elevada en endpoints que en aislamiento son
   * rápidos (GET /conversaciones: 4.5 ms de servidor por EXPLAIN ANALYZE,
   * pero 200-460 ms de punta a punta en esos momentos) — compatible con
   * contención en la única CPU del servidor durante esa ráfaga. Subir a 1h
   * corta la frecuencia de ese round-trip a una sexta parte sin arriesgar
   * nada: `GET /conversaciones/meta/plantillas?refresh=true` sigue
   * disponible para quien necesite la lista al segundo.
   */
  private readonly cachePlantillas = new CacheMemoria<PlantillaResumen[]>({
    ttlMs: 3_600_000,
    maxEntradas: 1,
  });

  /**
   * Visibilidad por rol: AGENTE ve sus conversaciones + las sin asignar; ADMIN todo.
   *
   * **Paginado y filtrado en Postgres desde 2026-08-27.** Antes devolvía las 500
   * más recientes de golpe y el navegador resolvía pestañas, filtro por agente y
   * buscador en memoria sobre ese corte. Con eso, una conversación en el puesto
   * 501 no estaba "en la página siguiente": no existía para la interfaz, y sobre
   * todo **no aparecía al buscar a esa paciente por nombre** — la agente leía
   * "sin resultados" y concluía que la paciente no estaba en el sistema. Al
   * ritmo medido (+13,3 conversaciones/día sobre 325) el tope caía el 8 de
   * septiembre de 2026.
   *
   * Subir el número solo movía la fecha. Lo que se arregló es la causa: las
   * cuatro operaciones —ordenar, filtrar por pestaña, filtrar por agente y
   * buscar— ahora ocurren donde están todos los datos.
   *
   * @param soloAgenteId Permiso: a qué agente se acota. `undefined` = ve todo.
   * @param usuarioId    Quién pregunta. Solo para las vistas que se definen
   *                     respecto de uno mismo ("solo míos", pestaña "Mis chats").
   * @param query        Preferencias de vista y paginación. Nunca amplían el permiso.
   */
  async findAll(
    soloAgenteId: string | undefined,
    usuarioId: string,
    query: QueryConversacionesDto = {},
  ): Promise<RespuestaPaginada<ConversacionDeInbox> & { contadores: ContadoresInbox }> {
    /* El permiso va primero y siempre; lo demás son preferencias de vista que
       se le suman con AND. Fundirlos es cómo un interruptor de la interfaz
       termina redefiniendo quién ve los datos de qué paciente. */
    const where = combinar(
      whereVisibilidad(soloAgenteId),
      query.soloMios ? whereSoloMios(usuarioId) : undefined,
      whereTab(query.tab, usuarioId),
      whereBusqueda(query.busqueda),
      whereAgente(query.agenteId),
    );

    const dto = { pagina: query.pagina, limite: query.limite ?? POR_PAGINA_INBOX };
    const { skip, take } = calcularPaginacion(dto);

    /* Página y total en un solo viaje, como manda `crm-backend-module`. */
    const [conversaciones, total] = await this.prisma.$transaction([
      this.prisma.conversacion.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        select: SELECT_INBOX,
        skip,
        take,
      }),
      this.prisma.conversacion.count({ where }),
    ]);

    return {
      ...paginar(conversaciones.map(aFilaDeInbox), total, dto),
      contadores: await this.contadoresInbox(soloAgenteId, usuarioId, query.soloMios),
    };
  }

  /**
   * Los números de las cuatro pestañas.
   *
   * Se calculan sobre el ALCANCE del usuario, no sobre la pestaña ni la búsqueda
   * activas — igual que hacía el `stats` del frontend, que contaba sobre la lista
   * completa cargada y no sobre la filtrada. Si dependieran del filtro activo,
   * la pestaña "Sin responder" mostraría "0" mientras estás dentro de ella
   * habiendo escrito algo en el buscador.
   *
   * Cuatro `count` indexados en una sola transacción: `agenteId` sostiene dos y
   * `esperandoRespuesta` el tercero.
   */
  private async contadoresInbox(
    soloAgenteId: string | undefined,
    usuarioId: string,
    soloMios?: boolean,
  ): Promise<ContadoresInbox> {
    const base = combinar(
      whereVisibilidad(soloAgenteId),
      soloMios ? whereSoloMios(usuarioId) : undefined,
    );

    const conBase = (extra?: Prisma.ConversacionWhereInput) => combinar(base, extra);

    const [total, sinAsignar, misChats, sinResponder] = await this.prisma.$transaction([
      this.prisma.conversacion.count({ where: base }),
      this.prisma.conversacion.count({ where: conBase({ agenteId: null }) }),
      this.prisma.conversacion.count({ where: conBase({ agenteId: usuarioId }) }),
      this.prisma.conversacion.count({ where: conBase({ esperandoRespuesta: true }) }),
    ]);

    return { total, sinAsignar, misChats, sinResponder };
  }

  /**
   * Una sola fila del inbox, para el aviso de tiempo real.
   *
   * Cuando llega un mensaje, el frontend necesita refrescar ESA conversación,
   * no las 500 (ni la página entera). Devuelve `null` si la conversación ya no
   * pertenece a la vista activa —le contestaron y estabas en "Sin responder",
   * te la reasignaron y estabas en "Mis chats"— para que el navegador la quite
   * en vez de dejar una fila que ya no corresponde.
   *
   * El `where` se arma con los MISMOS constructores que `findAll`, así que el
   * permiso se aplica igual: nadie recibe por esta vía una conversación que no
   * podría ver en el listado.
   */
  async resumenParaInbox(
    id: string,
    soloAgenteId: string | undefined,
    usuarioId: string,
    query: QueryConversacionesDto = {},
  ): Promise<{ conversacion: ConversacionDeInbox | null; contadores: ContadoresInbox }> {
    const fila = await this.prisma.conversacion.findFirst({
      where: combinar(
        { id },
        whereVisibilidad(soloAgenteId),
        query.soloMios ? whereSoloMios(usuarioId) : undefined,
        whereTab(query.tab, usuarioId),
        whereBusqueda(query.busqueda),
        whereAgente(query.agenteId),
      ),
      select: SELECT_INBOX,
    });

    return {
      conversacion: fila ? aFilaDeInbox(fila) : null,
      contadores: await this.contadoresInbox(soloAgenteId, usuarioId, query.soloMios),
    };
  }

  /**
   * @param soloAgenteId Si viene (usuario AGENTE, no ADMIN), solo puede ver
   *   conversaciones propias o sin asignar. Sin esto, cualquier agente podía
   *   leer o responder la conversación de OTRO agente por ID, sin importar
   *   quién la tenía asignada. 404 en vez de 403 para no confirmar existencia.
   */
  async findOne(id: string, soloAgenteId?: string) {
    const conversacion = await this.prisma.conversacion.findUnique({
      where: { id },
      include: {
        cliente: {
          select: {
            id: true,
            nombre: true,
            telefono: true,
            email: true,
            categoria: true,
            pac: true,
            fechaNacimiento: true,
            ocupacion: true,
            empresaTrabajo: true,
            ciLugar: true,
            datosExtra: true,
            intereses: { select: { id: true, descripcion: true } },
            /* Lo consume `puedeVerConversacion`: sin esto el detalle no puede
               aplicar la misma regla de visibilidad que el listado. */
            agenteId: true,
            agente: { select: { id: true, nombre: true } },
          },
        },
        agente: { select: { id: true, nombre: true } },
        /* Se traen las más recientes primero (para poder acotar con `take`)
           y se reordenan a ascendente en memoria — invertir 300 elementos
           es despreciable frente a traer un historial sin límite. */
        mensajes: { orderBy: { createdAt: 'desc' }, take: LIMITE_MENSAJES_DETALLE },
      },
    });
    if (!conversacion || !puedeVerConversacion(conversacion, soloAgenteId)) {
      throw new NotFoundException(`Conversación ${id} no encontrada`);
    }
    conversacion.mensajes.reverse();

    /* A cada mensaje con archivo se le adjunta una URL firmada fresca (15 min):
       el frontend la usa como `src` de la imagen/audio/enlace. Se firman en
       paralelo; los mensajes de solo texto no pagan nada. */
    const mensajes = await Promise.all(
      conversacion.mensajes.map(async m => ({
        ...m,
        mediaUrl: m.mediaKey ? await this.r2.urlFirmada(m.mediaKey) : null,
      })),
    );
    return {
      ...conversacion,
      agente: conversacion.agente ?? conversacion.cliente?.agente ?? null,
      mensajes,
    };
  }

  /**
   * Paginación por CURSOR para mensajes antiguos (scroll infinito hacia arriba).
   * Filtra mensajes creados estrictamente ANTES del timestamp dado (`antesDe`).
   */
  async obtenerMensajesAnteriores(id: string, antesDe: string, limit = 50, soloAgenteId?: string) {
    await this.obtenerConversacionPropia(id, soloAgenteId);
    const limiteParsed = Math.min(Math.max(Number(limit) || 50, 1), 100);

    const mensajes = await this.prisma.mensaje.findMany({
      where: {
        conversacionId: id,
        createdAt: { lt: new Date(antesDe) },
      },
      orderBy: { createdAt: 'desc' },
      take: limiteParsed,
    });
    mensajes.reverse();

    return Promise.all(
      mensajes.map(async m => ({
        ...m,
        mediaUrl: m.mediaKey ? await this.r2.urlFirmada(m.mediaKey) : null,
      })),
    );
  }

  /**
   * Búsqueda histórica en el chat: mira TODO el hilo en la base, no solo los
   * mensajes que el navegador tiene cargados. Sin mayúsculas/minúsculas y
   * paginada.
   *
   * El escopado por rol no es decorativo: el id de la conversación viaja en la
   * URL, así que sin él esto sería una puerta lateral para leer el historial de
   * la paciente de otra agente. Va por `obtenerConversacionPropia`, igual que
   * `findOne`.
   *
   * Entra por el índice `[conversacionId, createdAt]`, así que el recorrido del
   * texto queda acotado a un solo chat.
   */
  async buscarMensajes(
    id: string,
    termino: string,
    limit = 20,
    skip = 0,
    soloAgenteId?: string,
  ) {
    await this.obtenerConversacionPropia(id, soloAgenteId);
    const busqueda = (termino || '').trim();
    if (!busqueda) return { total: 0, items: [] };

    const where = {
      conversacionId: id,
      contenido: { contains: escaparComodinesLike(busqueda), mode: 'insensitive' as const },
    };

    const [total, items] = await Promise.all([
      this.prisma.mensaje.count({ where }),
      this.prisma.mensaje.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: Math.min(Math.max(Number(limit) || 20, 1), 50),
        skip: Math.max(Number(skip) || 0, 0),
        select: {
          id: true,
          contenido: true,
          direccion: true,
          createdAt: true,
          tipo: true,
          estadoEnvio: true,
        },
      }),
    ]);

    return { total, items };
  }

  /** Versión liviana del chequeo de propiedad de `findOne`, sin traer mensajes:
   *  la usan `enviarMensaje`/`asignarAgente`, que solo necesitan confirmar
   *  dueño + el teléfono del cliente, no el historial completo del chat. */
  private async obtenerConversacionPropia(id: string, soloAgenteId?: string) {
    const conversacion = await this.prisma.conversacion.findUnique({
      where: { id },
      select: {
        id: true,
        agenteId: true,
        clienteId: true,
        cliente: { select: { telefono: true, agenteId: true } },
      },
    });
    if (!conversacion || !puedeVerConversacion(conversacion, soloAgenteId)) {
      throw new NotFoundException(`Conversación ${id} no encontrada`);
    }
    return conversacion;
  }

  /**
   * Ventana de servicio al cliente (CSW): WhatsApp solo entrega texto libre
   * hasta 24h después del último mensaje ENTRANTE del paciente. Pasada esa
   * hora, Meta rechaza el envío igual (queda como FALLIDO tras el webhook de
   * `statuses`) — esto solo evita gastar el viaje y avisa al agente al toque
   * en vez de dejarlo esperando un tick que nunca llega.
   *
   * La ventana de 72h por anuncio Click-to-WhatsApp (Free Entry Point) NO
   * cuenta acá: esa solo habilita mandar PLANTILLAS sin costo (`enviarPlantilla`),
   * nunca texto libre. Son independientes — mismo criterio que
   * `fueraDeVentana24h` del frontend; si se toca uno, se toca el otro.
   */
  private async verificarVentana24h(conversacionId: string): Promise<void> {
    const ultimoEntrante = await this.prisma.mensaje.findFirst({
      where: { conversacionId, direccion: 'ENTRANTE' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });

    if (!ultimoEntrante) {
      throw new BadRequestException(
        'El paciente todavía no escribió en este chat: para iniciar contacto hay que usar una Plantilla de WhatsApp.',
      );
    }

    const haceHoras = (Date.now() - ultimoEntrante.createdAt.getTime()) / (1000 * 60 * 60);
    if (haceHoras >= 24) {
      throw new BadRequestException(
        'Han pasado más de 24h desde el último mensaje del paciente. Usa una Plantilla de WhatsApp.',
      );
    }
  }

  /**
   * `soloAgenteId` — ver la nota de `findOne`. Si la conversación estaba sin
   * asignar, el envío la asigna al agente que responde primero.
   *
   * "Si estaba sin asignar" es literal: antes el `update` escribía `agenteId`
   * siempre, así que un ADMIN que contestara un chat ajeno se lo quitaba al
   * agente que lo tenía — y con la conversación se movía la atribución. Ahora
   * la condición la evalúa la base (`updateMany` con `agenteId: null` en el
   * where), que además resuelve el empate si dos agentes contestan a la vez el
   * mismo chat del pool: exactamente uno se lo lleva.
   */
  async enviarMensaje(
    conversacionId: string,
    contenido: string,
    agenteId: string,
    soloAgenteId?: string,
    adjunto?: { mediaKey?: string; mediaMime?: string; mediaNombre?: string },
  ) {
    const conversacion = await this.obtenerConversacionPropia(conversacionId, soloAgenteId);
    await this.verificarVentana24h(conversacionId);

    /* Un solo round-trip a la base para ambos writes, y atómico: si el update
       de la conversación falla, no queda un mensaje huérfano sin reflejarse
       en updatedAt/agenteId. `estadoEnvio: ENVIADO` es optimista (el tick
       sencillo aparece antes de saber si Meta lo aceptó), igual que hace
       WhatsApp/Messenger — se corrige a FALLIDO si el envío real rebota. */
    const [mensaje] = await this.prisma.$transaction([
      this.prisma.mensaje.create({
        data: {
          conversacionId,
          direccion: 'SALIENTE',
          contenido,
          estadoEnvio: 'ENVIADO',
          /* Se guarda la CLAVE, no la URL: el detalle firma una nueva en cada
             carga y la burbuja no caduca. Ver el comentario de `mediaKey` en
             EnviarMensajeDto. */
          ...(adjunto?.mediaKey
            ? {
                mediaKey: adjunto.mediaKey,
                mediaMime: adjunto.mediaMime ?? null,
                mediaNombre: adjunto.mediaNombre ?? null,
                tipo: tipoSegunMime(adjunto.mediaMime),
              }
            : {}),
        },
      }),
      /* Solo reclama el chat si está en el pool — ver la nota del método. */
      this.prisma.conversacion.updateMany({
        where: { id: conversacionId, agenteId: null },
        data: { agenteId },
      }),
      this.prisma.conversacion.update({
        where: { id: conversacionId },
        /* Contestó una persona: sale de la pestaña "Sin responder". Va en la
           MISMA transacción que el mensaje a propósito — si se separara, un
           fallo entre las dos dejaría la pestaña mintiendo. */
        data: { updatedAt: new Date(), esperandoRespuesta: false },
      }),
    ]);

    /* La misma reclamación, para la paciente y sus leads abiertos.
       Va por `clientesService` y no con un `updateMany` aquí porque `Cliente` y
       `Lead` son de otro dominio: escribirlas desde este módulo deja la regla
       —qué se reclama, qué se respeta, qué se audita— en dos sitios que se
       separan al primer cambio. Fuera de la transacción a propósito: que la
       paciente quede sin dueña no puede tumbar el envío de un mensaje que ya
       salió hacia Meta.

       El `catch` es lo que hace verdad esa última frase. Era un `await` pelado,
       y el despacho a Meta va DESPUÉS: si esta escritura fallaba —un deadlock,
       un timeout— la excepción se llevaba consigo el `void despachador…`, así
       que el mensaje quedaba guardado en el CRM y NO SALÍA hacia la paciente.
       La agente veía un 500 sobre un mensaje que ya aparecía en el hilo, y al
       reintentar lo duplicaba. */
    await this.clientesService
      .reclamarSiNoTieneDuena(conversacion.clienteId, agenteId, agenteId)
      .catch(error =>
        this.logger.error(
          `No se pudo reclamar la paciente ${conversacion.clienteId} para ${agenteId}`,
          error,
        ),
      );

    /* Empuja el refresco a los demás clientes conectados (ver ConversacionesGateway). */
    this.gateway.emitirActividad(conversacionId);

    /* Envío real por WhatsApp Cloud API — deliberadamente SIN await: el
       agente no debe esperar el round-trip a Meta (300-900ms típico, a veces
       más) para ver su mensaje como enviado. El resultado (Meta ID o FALLIDO)
       se corrige en segundo plano y empuja un segundo aviso por WebSocket
       para actualizar el tick sin que el agente tenga que refrescar. */
    void this.despachador.texto(
      { mensajeId: mensaje.id, conversacionId, telefono: conversacion.cliente.telefono },
      contenido,
      adjunto?.mediaKey,
    );

    return { ...mensaje, clienteTelefono: conversacion.cliente.telefono };
  }

  /**
   * Manda el acuse como mensaje interactivo con botones de respuesta rápida.
   *
   * El paciente toca uno y su elección vuelve por el webhook como un mensaje
   * normal: `extraerRespuestaBoton` ya sabe leer `interactive.button_reply.title`
   * —se arregló al tapar el aislamiento del lote— así que no hace falta tocar
   * nada del lado entrante. El valor no es automatizar la gestión, que sigue
   * necesitando una persona: es que el lunes el hilo diga "Agendar una cita" en
   * lugar de "hola".
   *
   * Si Meta rechaza el interactivo se reintenta como texto plano. Un acuse feo
   * es mejor que ninguno.
   */

  /**
   * Confirmaciones de entrega/lectura del webhook de WhatsApp (`statuses`).
   * Se correlaciona por `whatsappMsgId` — el id que Meta devolvió al enviar.
   * Un mensaje puede recibir varios statuses de mejor a peor (sent → delivered
   * → read); si llegan fuera de orden, nunca se retrocede LEIDO → ENTREGADO.
   */
  async procesarEstadoMensaje(whatsappMsgId: string, status: string): Promise<void> {
    const mensaje = await this.prisma.mensaje.findUnique({ where: { whatsappMsgId } });
    if (!mensaje) {
      return; // status de un mensaje que no reconocemos (o llegó antes que el propio envío se guardara)
    }

    const ahora = new Date();
    if (status === 'read' && mensaje.estadoEnvio !== 'LEIDO') {
      await this.prisma.mensaje.update({
        where: { id: mensaje.id },
        data: { estadoEnvio: 'LEIDO', leidoEn: mensaje.leidoEn ?? ahora, entregadoEn: mensaje.entregadoEn ?? ahora },
      });
    } else if (status === 'delivered' && mensaje.estadoEnvio !== 'LEIDO' && mensaje.estadoEnvio !== 'ENTREGADO') {
      await this.prisma.mensaje.update({
        where: { id: mensaje.id },
        data: { estadoEnvio: 'ENTREGADO', entregadoEn: ahora },
      });
    } else if (status === 'failed') {
      await this.prisma.mensaje.update({
        where: { id: mensaje.id },
        data: { estadoEnvio: 'FALLIDO' },
      });
    } else {
      return; // 'sent' o repetido: nada nuevo que reflejar
    }

    this.gateway.emitirActividad(mensaje.conversacionId);
  }

  /**
   * Lista las plantillas APROBADAS de la WABA — para el selector del inbox.
   * Solo las aprobadas se pueden enviar (Meta rechaza el resto). Se piden los
   * campos mínimos que la UI necesita para previsualizar y contar variables.
   */
  async listarPlantillas(forceRefresh = false): Promise<PlantillaResumen[]> {
    if (!forceRefresh) {
      const cacheado = this.cachePlantillas.obtener(CLAVE_PLANTILLAS);
      if (cacheado) return cacheado;
    }

    try {
      const crudas = await this.whatsapp.listarPlantillas();
      /* null = no se pudieron pedir. Se devuelve lo último bueno que hubiera en
         caché antes que una lista vacía: un selector vacío parece "no tienes
         plantillas", que es otra cosa. Por eso se pide "aunque haya vencido":
         justo cuando Meta no responde es cuando la entrada suele estar caducada. */
      if (!crudas) return this.cachePlantillas.obtenerAunqueVencido(CLAVE_PLANTILLAS) ?? [];

      const data = { data: crudas as PlantillaMeta[] };
      const resultado = (data.data ?? [])
        .filter(p => p.status === 'APPROVED')
        .map(p => {
          const body = p.components?.find(c => c.type === 'BODY')?.text ?? '';
          return {
            nombre: p.name,
            idioma: p.language,
            categoria: p.category,
            cuerpo: body,
            /* Nº de variables del cuerpo: cuenta los {{...}} distintos para que
               la UI sepa cuántos campos pedir antes de enviar. */
            variables: [...new Set(body.match(/\{\{[^}]+\}\}/g) ?? [])].length,
          };
        });

      this.cachePlantillas.guardar(CLAVE_PLANTILLAS, resultado);
      return resultado;
    } catch (error) {
      this.logger.error('Excepción al listar plantillas de Meta', error);
      return this.cachePlantillas.obtenerAunqueVencido(CLAVE_PLANTILLAS) ?? [];
    }
  }

  /**
   * Envía una plantilla aprobada a un paciente — único modo permitido fuera de
   * la ventana de 24h. Mismo patrón que `enviarMensaje`: persiste, avisa por
   * WebSocket, y dispara la llamada a Meta SIN await (el agente no espera el
   * round-trip). `contenido` es el texto ya renderizado que se guarda.
   */
  async enviarPlantilla(
    conversacionId: string,
    dto: { plantilla: string; idioma: string; parametros?: string[]; contenido: string },
    agenteId: string,
    soloAgenteId?: string,
  ) {
    const conversacion = await this.obtenerConversacionPropia(conversacionId, soloAgenteId);

    const [mensaje] = await this.prisma.$transaction([
      this.prisma.mensaje.create({
        data: { conversacionId, direccion: 'SALIENTE', contenido: dto.contenido, estadoEnvio: 'ENVIADO' },
      }),
      /* Mismo criterio que `enviarMensaje`: reclamar solo si está en el pool. */
      this.prisma.conversacion.updateMany({
        where: { id: conversacionId, agenteId: null },
        data: { agenteId },
      }),
      this.prisma.conversacion.update({
        where: { id: conversacionId },
        /* Contestó una persona: sale de la pestaña "Sin responder". Va en la
           MISMA transacción que el mensaje a propósito — si se separara, un
           fallo entre las dos dejaría la pestaña mintiendo. */
        data: { updatedAt: new Date(), esperandoRespuesta: false },
      }),
    ]);

    this.gateway.emitirActividad(conversacionId);

    void this.despachador.plantilla(
      { mensajeId: mensaje.id, conversacionId, telefono: conversacion.cliente.telefono },
      dto,
    );

    return { ...mensaje, clienteTelefono: conversacion.cliente.telefono };
  }

  /**
   * Marca el último mensaje entrante como leído (tildes azules para el
   * paciente) y, si `typing`, muestra "escribiendo…". Se llama al abrir el
   * chat y mientras el agente redacta — así el paciente ve que lo atienden,
   * como en cualquier CRM de primer nivel. Fire-and-forget: nunca demora la UI.
   */
  async marcarLeido(conversacionId: string, soloAgenteId?: string, typing = false): Promise<{ ok: boolean }> {
    const conv = await this.prisma.conversacion.findUnique({
      where: { id: conversacionId },
      select: { id: true, agenteId: true, cliente: { select: { agenteId: true } } },
    });
    if (!conv || !puedeVerConversacion(conv, soloAgenteId)) {
      return { ok: false };
    }

    /* Marca todos los mensajes entrantes sin leer como leídos en la BD */
    await this.prisma.mensaje.updateMany({
      where: { conversacionId, direccion: 'ENTRANTE', leidoEn: null },
      data: { leidoEn: new Date() },
    });

    /* Solo los mensajes entrantes tienen whatsappMsgId para referenciar */
    const ultimoEntrante = await this.prisma.mensaje.findFirst({
      where: { conversacionId, direccion: 'ENTRANTE', whatsappMsgId: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { whatsappMsgId: true },
    });
    if (ultimoEntrante?.whatsappMsgId) {
      void this.enviarEstadoLectura(ultimoEntrante.whatsappMsgId, typing);
    }
    return { ok: true };
  }

  /** Ver `marcarLeido`: se dispara sin await a propósito. */
  private async enviarEstadoLectura(whatsappMsgId: string, typing: boolean): Promise<void> {
    await this.whatsapp.marcarLeido(whatsappMsgId, typing);
  }

  /**
   * Asignar/reasignar un agente a una conversación (solo ADMIN).
   *
   * Reasignar un chat arrastra al cliente y a sus leads — si no, el inbox diría
   * una cosa y Oportunidades otra. Pero esas dos tablas son de otros dominios:
   * antes se escribían aquí con `prisma.cliente.update` y `prisma.lead.updateMany`,
   * saltándose la regla de oro nº1 y, de paso, la auditoría. `ClientesService.update()`
   * ya hacía exactamente esta cascada (cliente + leads + conversaciones) y además
   * registra en `AuditLog`, así que la reasignación es suya y aquí solo se pide.
   */
  async asignarAgente(conversacionId: string, agenteId: string | null, usuarioId?: string) {
    const conversacion = await this.prisma.conversacion.findUnique({
      where: { id: conversacionId },
      select: { id: true, clienteId: true },
    });
    if (!conversacion) {
      throw new NotFoundException(`Conversación ${conversacionId} no encontrada`);
    }

    if (agenteId) {
      const agente = await this.prisma.usuario.findUnique({ where: { id: agenteId } });
      if (!agente || !agente.activo) {
        throw new NotFoundException(`Agente ${agenteId} no encontrado o inactivo`);
      }
    }

    await this.clientesService.update(conversacion.clienteId, { agenteId }, usuarioId);

    /* Se relee para devolver la misma forma de antes: el update vive en Clientes
       y devuelve un cliente, no la conversación que espera el inbox. */
    const actualizada = await this.prisma.conversacion.findUniqueOrThrow({
      where: { id: conversacionId },
      include: {
        cliente: {
          select: {
            id: true,
            nombre: true,
            telefono: true,
            categoria: true,
            agente: { select: { id: true, nombre: true } },
          },
        },
        agente: { select: { id: true, nombre: true } },
      },
    });

    return {
      ...actualizada,
      agente: actualizada.agente ?? actualizada.cliente?.agente ?? null,
    };
  }

  /** Lista de agentes activos — para el dropdown de asignación del admin (cacheada 30s). */
  async findAgentes() {
    return this.cacheAgentes.resolver(CLAVE_AGENTES, () =>
      this.prisma.usuario.findMany({
        where: { activo: true },
        select: { id: true, nombre: true, rol: true },
        orderBy: { nombre: 'asc' },
      }),
    );
  }
}
