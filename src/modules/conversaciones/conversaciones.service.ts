import { pagoDelChat, promocionDelChat } from './pagos-chat';
import { sugerenciaDelChat } from './sugerencias-chat';
import { esOfertaComercial } from './interaccion-comercial';
import { estadoDeIntentoAnterior, verificarIntencion, datosOferta, interaccionesEnLinea, OfertaInteraccion, prepararOferta, proyectarInteracciones } from './interacciones-integracion';
import { MemoriaAgenteService } from '../memoria-agente/memoria-agente.service';
import { whereAccesoConversacion as whereVisibilidad, SELECT_LINEA } from './acceso-conversacion';
import {
  aFilaDeInbox,
  combinar,
  ContadoresInbox,
  ConversacionDeInbox,
  SELECT_INBOX,
  whereAlcanceInbox,
  wherePestanas,
  whereVistaInbox,
} from './consultas-inbox';
import { LineasWhatsappService } from '../lineas-whatsapp/lineas-whatsapp.service';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, Rol, TipoMensaje } from '../../prisma/prisma-client';

import { ROLES_ALCANCE_GLOBAL } from '../../common/auth/roles';
import { CacheMemoria } from '../../common/cache/cache-memoria';
import { escaparComodinesLike } from '../../common/dto/busqueda';
import { calcularPaginacion, paginar, RespuestaPaginada } from '../../common/dto/pagination.dto';
import { enSegundoPlano } from '../../common/fiabilidad/en-segundo-plano';
import { CONTENIDO_PIN, UBICACION_CLINICA } from './ubicacion-clinica';
import { R2Service } from '../../common/storage/r2.service';
import { WhatsappCloudService } from '../../common/whatsapp/whatsapp-cloud.service';
import { ERROR_BAJA_MARKETING, permiteReintentarError } from '../../common/whatsapp/error-envio';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientesService } from '../clientes/clientes.service';
import { ConversacionesGateway } from './conversaciones.gateway';
import { obtenerConversacionPropia, recuperarEnvioDuplicado } from './envio-comun';
import { DespachadorSalienteService, proximoReintento } from './despachador-saliente.service';
import { QueryConversacionesDto } from './dto/query-conversaciones.dto';
import { REABRIR } from './estado-conversacion';
import { auditarResolucion, bloquearSolicitudViva, contextoDeAtencion, ESPERANDO_HUMANO, ORDEN_ATENCION } from './atencion-humana';
import { ultimosMensajesDeInbox } from './lectura-mensajes-inbox';
import { motivoParaNoReenviar, reclamarReenvio } from './reenvio-manual';

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

/** Un adjunto saliente: la clave en R2 y lo que se sabe del archivo. */
interface AdjuntoMensaje {
  mediaKey?: string;
  mediaMime?: string;
  mediaNombre?: string;
  mediaAncho?: number | null;
  mediaAlto?: number | null;
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
  rol: Rol;
  lineasWhatsapp: { lineaId: string }[];
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

/** Tipo de mensaje a partir del MIME del archivo subido por el agente. */

function tipoSegunMime(mime: string | undefined): TipoMensaje {
  if (!mime) return 'DOCUMENTO';
  if (mime.startsWith('image/')) return 'IMAGEN';
  if (mime.startsWith('video/')) return 'VIDEO';
  if (mime.startsWith('audio/')) return 'AUDIO';
  return 'DOCUMENTO';
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
    private readonly lineas: LineasWhatsappService,
    private readonly memoria: MemoriaAgenteService,
  ) {}

  /** Dropdown de asignación del admin: cambia solo al dar de alta o baja a alguien. */
  private readonly cacheAgentes = new CacheMemoria<AgenteResumen[]>({
    ttlMs: 30_000,
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
    const where = whereVistaInbox(query, soloAgenteId, usuarioId);

    const dto = { pagina: query.pagina, limite: query.limite ?? POR_PAGINA_INBOX };
    const { skip, take } = calcularPaginacion(dto);

    /* Página y total en la misma transacción. */
    const [conversaciones, total] = await this.prisma.$transaction([
      this.prisma.conversacion.findMany({
        where,
        /* «Atención» es la única vista que no ordena por actividad: ahí manda
           quién espera, con qué prioridad y desde cuándo (`ORDEN_ATENCION`). */
        orderBy: query.tab === 'ATENCION' ? ORDEN_ATENCION : [{ updatedAt: 'desc' }, { id: 'desc' }],
        select: SELECT_INBOX,
        skip,
        take,
      }),
      this.prisma.conversacion.count({ where }),
    ]);

    const ultimos = await ultimosMensajesDeInbox(this.prisma, conversaciones.map(c => c.id));
    return {
      ...paginar(conversaciones.map(c => aFilaDeInbox(c, ultimos.get(c.id))), total, dto),
      contadores: await this.contadoresInbox(query, soloAgenteId, usuarioId),
    };
  }

  /**
   * Los números de las pestañas.
   *
   * Se calculan sobre el ALCANCE del usuario, no sobre la pestaña ni la búsqueda
   * activas — igual que hacía el `stats` del frontend, que contaba sobre la lista
   * completa cargada y no sobre la filtrada. Si dependieran del filtro activo,
   * la pestaña "Sin responder" mostraría "0" mientras estás dentro de ella
   * habiendo escrito algo en el buscador.
   *
   * Cinco `count` en una sola transacción, con el mismo alcance.
   */
  private async contadoresInbox(
    query: QueryConversacionesDto,
    soloAgenteId: string | undefined,
    usuarioId: string,
  ): Promise<ContadoresInbox> {
    /* El MISMO alcance que la lista (`whereAlcanceInbox`) y las mismas
       condiciones que cada pestaña (`wherePestanas`): lo que dice el número es
       lo que aparece al pulsarla. Sin la búsqueda, a propósito (ver arriba). */
    const alcance = whereAlcanceInbox(query, soloAgenteId, usuarioId);
    const pestanas = wherePestanas(usuarioId);
    const contar = (pestana: Prisma.ConversacionWhereInput) =>
      this.prisma.conversacion.count({ where: combinar(alcance, pestana) });

    const [total, sinAsignar, misChats, sinResponder, cerradas, esperandoHumano, enAtencion] = await this.prisma.$transaction([
      contar(pestanas.total),
      contar(pestanas.sinAsignar),
      contar(pestanas.misChats),
      contar(pestanas.sinResponder),
      contar(pestanas.cerradas),
      contar(pestanas.esperandoHumano),
      contar(pestanas.enAtencion),
    ]);

    return { total, sinAsignar, misChats, sinResponder, cerradas, esperandoHumano, enAtencion };
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
      where: combinar({ id }, whereVistaInbox(query, soloAgenteId, usuarioId)),
      select: SELECT_INBOX,
    });

    const ultimos = await ultimosMensajesDeInbox(this.prisma, fila ? [fila.id] : []);
    return {
      conversacion: fila ? aFilaDeInbox(fila, ultimos.get(fila.id)) : null,
      contadores: await this.contadoresInbox(query, soloAgenteId, usuarioId),
    };
  }

  /**
   * @param soloAgenteId Si viene (usuario AGENTE, no ADMIN), solo puede ver
   *   conversaciones propias o sin asignar. Sin esto, cualquier agente podía
   *   leer o responder la conversación de OTRO agente por ID, sin importar
   *   quién la tenía asignada. 404 en vez de 403 para no confirmar existencia.
   */
  async findOne(id: string, soloAgenteId?: string) {
    const conversacion = await this.prisma.conversacion.findFirst({
      where: { id, ...whereVisibilidad(soloAgenteId) },
      include: {
        linea: { select: SELECT_LINEA },
        cliente: {
          select: {
            id: true,
            nombre: true,
            telefono: true,
            email: true,
            categoria: true,
            /* El control de categoría de la ficha dice si está fijada a mano. */
            categoriaFijadaEn: true,
            pac: true,
            ci: true,
            fechaNacimiento: true,
            ocupacion: true,
            empresaTrabajo: true,
            ciLugar: true,
            datosExtra: true,
            intereses: { select: { id: true, descripcion: true } },
            /* El chat avisa que no quiere promociones y el selector apaga las
               de Marketing. Solo el detalle: el listado no lo necesita. */
            bajaPromocionesEn: true,
            /* Lo consume `puedeVerConversacion`: sin esto el detalle no puede
               aplicar la misma regla de visibilidad que el listado. */
            agenteId: true,
            agente: { select: { id: true, nombre: true } },
          },
        },
        agente: { select: { id: true, nombre: true } },
        /* El aviso «cerrada por X / por inactividad» del chat. */
        cerradaPor: { select: { id: true, nombre: true } },
        /* El bloque de atención humana: «En atención por Ana». */
        atencionTomadaPor: { select: { id: true, nombre: true } },
        /* Se traen las más recientes primero (para poder acotar con `take`)
           y se reordenan a ascendente en memoria — invertir 300 elementos
           es despreciable frente a traer un historial sin límite. */
        /* Mismo orden total que `obtenerMensajesAnteriores`: el mensaje más
           antiguo de esta página es el cursor de la siguiente, así que si aquí
           los empatados salieran en otro orden, el cursor apuntaría a un sitio
           distinto del que la paginación supone. */
        mensajes: {
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: LIMITE_MENSAJES_DETALLE,
        },
      },
    });
    if (!conversacion) {
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
    /* Ya con el acceso comprobado arriba: todo se lee acotado a este chat, en
       paralelo. El pago de una promoción en curso (o el último, cerrado hace poco) y
       la promoción por la que llegó con su código. */
    const [atencion, pago, promocion, sugerencia] = await Promise.all([
      contextoDeAtencion(this.prisma, conversacion.id, conversacion),
      pagoDelChat(this.prisma, conversacion.id),
      conversacion.linea.comercial ? promocionDelChat(this.prisma, conversacion.clienteId) : null,
      /* Lo que el asistente le preparó a la agente (modo SUGERIR), si hay. */
      sugerenciaDelChat(this.prisma, conversacion.id),
    ]);
    return {
      ...conversacion,
      atencion,
      pago,
      promocion,
      sugerencia,
      /* `agente` es quien atiende el chat, sin caer a la dueña de la paciente:
         ver `aFilaDeInbox`. */
      cliente: conversacion.linea.comercial ? conversacion.cliente : { ...conversacion.cliente, datosExtra: null, intereses: [], agente: null, agenteId: null },
      mensajes: await proyectarInteracciones(this.prisma, mensajes),
    };
  }

  /**
   * Paginación por CURSOR para mensajes antiguos (scroll infinito hacia arriba).
   *
   * El cursor es el par `(createdAt, id)`, no solo la fecha. `createdAt` no
   * desempata: es `TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP` y en PostgreSQL eso
   * vale la hora de INICIO DE TRANSACCIÓN, así que cuanto persiste la ingesta
   * dentro de una misma transacción comparte el instante EXACTO. Con el `<`
   * estricto sobre la fecha sola, una página que cortara dentro de un grupo
   * empatado se saltaba al resto de ese grupo para siempre: recorriendo el hilo
   * entero se veían 5 de 8 mensajes, medido contra Postgres real.
   *
   * `antesDeId` es opcional para no romper a un cliente que solo mande la
   * fecha; el orden secundario por `id` sí es siempre el mismo, y sin él
   * PostgreSQL no promete ningún orden entre filas empatadas.
   */
  async obtenerMensajesAnteriores(
    id: string,
    antesDe: string,
    limit = 50,
    soloAgenteId?: string,
    antesDeId?: string,
  ) {
    await obtenerConversacionPropia(this.prisma, id, soloAgenteId);
    const limiteParsed = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const fecha = new Date(antesDe);

    const mensajes = await this.prisma.mensaje.findMany({
      where: {
        conversacionId: id,
        /* «Estrictamente anterior» en el orden total (createdAt desc, id desc):
           o la fecha es menor, o es la misma y el id va detrás. */
        ...(antesDeId
          ? {
              OR: [
                { createdAt: { lt: fecha } },
                { createdAt: fecha, id: { lt: antesDeId } },
              ],
            }
          : { createdAt: { lt: fecha } }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limiteParsed,
    });
    mensajes.reverse();

    return proyectarInteracciones(this.prisma, await Promise.all(
      mensajes.map(async m => ({
        ...m,
        mediaUrl: m.mediaKey ? await this.r2.urlFirmada(m.mediaKey) : null,
      })),
    ));
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
    await obtenerConversacionPropia(this.prisma, id, soloAgenteId);
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

  /**
   * La da por resuelta. Idempotente: cerrar una ya cerrada no le cambia ni la
   * fecha ni quién la cerró. Condicionado en el UPDATE, no leído antes: dos
   * pestañas cerrando a la vez no pisan al que cerró primero.
   *
   * SQL y no `updateMany` para no tocar `updatedAt`: Prisma lo pone en cada
   * UPDATE, y es la hora que el inbox muestra y por la que ordena. Cerrar un
   * chat de hace dos semanas no puede hacerlo pasar por «hace un momento».
   */
  async cerrar(id: string, usuarioId: string, soloAgenteId?: string) {
    await obtenerConversacionPropia(this.prisma, id, soloAgenteId);
    const ahora = new Date();
    await this.prisma.$transaction(async tx => {
      /* Cerrar con una solicitud de atención viva la resuelve: queda constancia
         de cuánto esperó, en la misma transacción que la borra. */
      const viva = await bloquearSolicitudViva(tx, id);
      const cerradas = await tx.$executeRaw`
        UPDATE "Conversacion" SET "cerradaEn" = ${ahora}, "cerradaPorId" = ${usuarioId},
          "atencionSolicitadaEn" = NULL, "atencionMotivo" = NULL, "atencionMensajeId" = NULL,
          "atencionTomadaEn" = NULL, "atencionTomadaPorId" = NULL
        WHERE id = ${id} AND "cerradaEn" IS NULL`;
      if (viva && cerradas) await auditarResolucion(tx, id, usuarioId, viva, 'CIERRE', ahora);
    });
    this.gateway.emitirActividad(id);
    return this.estadoDe(id);
  }

  /**
   * Vuelve a abrirla a mano (se reabre sola con actividad; esto es para cuando
   * no la hay). Sin tocar `updatedAt`, por lo mismo que `cerrar`.
   */
  async reabrir(id: string, soloAgenteId?: string) {
    await obtenerConversacionPropia(this.prisma, id, soloAgenteId);
    await this.prisma.$executeRaw`
      UPDATE "Conversacion" SET "cerradaEn" = NULL, "cerradaPorId" = NULL
      WHERE id = ${id} AND "cerradaEn" IS NOT NULL`;
    this.gateway.emitirActividad(id);
    return this.estadoDe(id);
  }

  private async estadoDe(id: string) {
    return this.prisma.conversacion.findUniqueOrThrow({
      where: { id },
      select: { id: true, cerradaEn: true, cerradaPor: { select: { id: true, nombre: true } } },
    });
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
   *
   * **Solo en líneas comerciales.** Allí el chat sigue a la cartera de la
   * agente. Una línea no comercial —Recepción, CLIMON— es atención compartida:
   * contestar primero no la vuelve de nadie, porque `whereAccesoConversacion`
   * le quitaría el chat a toda persona de la línea sin rol operativo. Asignar
   * sigue siendo posible, pero a propósito (`asignarAgente`, solo ADMIN).
   */
  /**
   * Los dos writes del envío, en una sola transacción.
   *
   * Extraído para que el `try` de `enviarMensaje` envuelva exactamente esto y
   * nada más: cuanto más código quede dentro, más fácil es que un error
   * ajeno acabe interpretado como un duplicado.
   */
  private crearMensajeSaliente(
    conversacionId: string,
    contenido: string,
    agenteId: string,
    adjunto?: AdjuntoMensaje,
    clientMessageId?: string,
    oferta?: OfertaInteraccion,
  ) {
      return this.prisma.$transaction([
        this.prisma.mensaje.create({
          data: {
            conversacionId,
            direccion: 'SALIENTE',
            contenido,
            estadoEnvio: oferta ? 'FALLIDO' : 'ENVIADO',
            ...(oferta && clientMessageId ? {
              proximoIntento: new Date(),
              interaccion: { create: datosOferta(oferta, clientMessageId) },
            } : {}),
            clientMessageId: clientMessageId ?? null,
            /* Se guarda la CLAVE, no la URL: el detalle firma una nueva en cada
               carga y la burbuja no caduca. Ver el comentario de `mediaKey` en
               EnviarMensajeDto. */
            ...(adjunto?.mediaKey
              ? {
                  mediaKey: adjunto.mediaKey,
                  mediaMime: adjunto.mediaMime ?? null,
                  mediaNombre: adjunto.mediaNombre ?? null,
                  mediaAncho: adjunto.mediaAncho ?? null,
                  mediaAlto: adjunto.mediaAlto ?? null,
                  tipo: tipoSegunMime(adjunto.mediaMime),
                }
              : {}),
          },
        }),
        /* Solo reclama el chat si está en el pool de una línea comercial — ver
           la nota del método. */
        this.prisma.conversacion.updateMany({
          where: { id: conversacionId, agenteId: null, linea: { comercial: true } },
          data: { agenteId },
        }),
        /* Contestar una solicitud en espera es tomarla: «En atención por» quien
           escribió. No toca `agenteId` (eso lo decide la línea de arriba). */
        this.prisma.conversacion.updateMany({
          where: { id: conversacionId, ...ESPERANDO_HUMANO },
          data: { atencionTomadaEn: new Date(), atencionTomadaPorId: agenteId },
        }),
        this.prisma.conversacion.update({
          where: { id: conversacionId },
          /* Contestó una persona: sale de la pestaña "Sin responder". Va en la
             MISMA transacción que el mensaje a propósito — si se separara, un
             fallo entre las dos dejaría la pestaña mintiendo. */
          data: { updatedAt: new Date(), esperandoRespuesta: false, ...REABRIR },
        }),
      ]);
  }

  async enviarMensaje(
    conversacionId: string,
    contenido: string,
    agenteId: string,
    soloAgenteId?: string,
    adjunto?: AdjuntoMensaje,
    clientMessageId?: string,
    interaccion?: unknown,
  ) {
    const conversacion = await obtenerConversacionPropia(this.prisma, conversacionId, soloAgenteId);
    await this.verificarVentana24h(conversacionId);
    if (interaccion !== undefined && (!clientMessageId || adjunto?.mediaKey)) throw new BadRequestException('Una interacción exige clientMessageId y no admite adjunto');
    /* En un piloto (`WHATSAPP_INTERACCIONES_LINEAS`), las demás líneas no mandan botones ni Flows. */
    if (interaccion !== undefined && !interaccionesEnLinea(conversacion.linea.id)) throw new BadRequestException('Interacciones desactivadas en esta línea');
    const oferta = interaccion === undefined ? undefined : prepararOferta(interaccion, conversacion.cliente.telefono, conversacion.linea.id);
    if (oferta && !conversacion.linea.comercial && esOfertaComercial(oferta)) {
      throw new BadRequestException('Las interacciones de promociones solo se envían desde líneas de Ventas.');
    }
    if (oferta) contenido = oferta.mensaje.cuerpo;
    if (adjunto?.mediaKey) {
      const propia = await this.memoria.archivoPropio(agenteId, adjunto.mediaKey);
      const delChat = propia ? null : await this.prisma.mensaje.findFirst({ where: { mediaKey: adjunto.mediaKey, conversacionId }, select: { mediaAncho: true, mediaAlto: true } });
      const origen = propia ?? delChat;
      if (!origen) throw new NotFoundException('Adjunto no encontrado en esta conversación ni en tu memoria');
      /* Las medidas salen del archivo guardado, no del navegador. */
      adjunto = { ...adjunto, mediaAncho: origen.mediaAncho, mediaAlto: origen.mediaAlto };
    }

    /* Un solo round-trip a la base para ambos writes, y atómico: si el update
       de la conversación falla, no queda un mensaje huérfano sin reflejarse
       en updatedAt/agenteId. `estadoEnvio: ENVIADO` es optimista (el tick
       sencillo aparece antes de saber si Meta lo aceptó), igual que hace
       WhatsApp/Messenger — se corrige a FALLIDO si el envío real rebota. */
    /*
     * Idempotencia del envío.
     *
     * El orden de este método hace que una respuesta HTTP perdida sea
     * indistinguible, desde el navegador, de un envío que nunca ocurrió: para
     * cuando el POST responde, el mensaje ya está en la base y el despacho a
     * Meta ya salió. Reintentar sin una clave estable creaba una segunda fila
     * y un segundo WhatsApp real.
     *
     * `clientMessageId` identifica la INTENCIÓN de envío, no el intento. La
     * garantía no es este código: es el índice único de PostgreSQL. Aquí solo
     * se traduce su rebote.
     *
     * No se comprueba antes con un `findUnique`, y no es pereza: entre el
     * SELECT y el INSERT cabe otra petición, así que el pre-chequeo no evita
     * la carrera —solo la disfraza de 500— y cobra un viaje de más en el
     * camino normal, que es el 99,9% de las veces. Mismo criterio que
     * `ClientesService.traducirChoqueUnico`, y el skill del módulo lo
     * documenta: bajo concurrencia, `upsert` tampoco sirve.
     */
    let mensaje;
    try {
      [mensaje] = await this.crearMensajeSaliente(conversacionId, contenido, agenteId, adjunto, clientMessageId, oferta);
    } catch (error) {
      const yaCreado = await recuperarEnvioDuplicado(this.prisma, this.logger, error, conversacionId, clientMessageId);
      if (!yaCreado) throw error;

      /*
       * Este `return` es el punto entero del cambio: sale ANTES de
       * `emitirActividad` y ANTES del despacho a Meta. La petición que
       * perdió la carrera —o el reintento de una respuesta perdida— devuelve
       * la MISMA fila y no vuelve a mandar nada a la paciente.
       *
       * Una fila, un despacho. La idempotencia de base de datos sin la del
       * efecto externo no serviría de nada.
       */
      if (oferta && clientMessageId) await verificarIntencion(this.prisma, yaCreado.id, clientMessageId, oferta);
      return { ...yaCreado, clienteTelefono: conversacion.cliente.telefono };
    }

    /* A partir de aquí solo pasa quien creó la fila de verdad. */
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
    if (conversacion.linea.comercial) await this.clientesService
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
    void enSegundoPlano(`envío del mensaje ${mensaje.id} a Meta`, this.logger, () =>
      oferta ? this.despachador.interaccion({ mensajeId: mensaje.id, conversacionId, telefono: conversacion.cliente.telefono }) : this.despachador.texto(
        { mensajeId: mensaje.id, conversacionId, telefono: conversacion.cliente.telefono },
        contenido,
        adjunto?.mediaKey
          ? { key: adjunto.mediaKey, mime: adjunto.mediaMime ?? null, nombre: adjunto.mediaNombre ?? null }
          : undefined,
      ),
    );

    return { ...mensaje, clienteTelefono: conversacion.cliente.telefono };
  }

  /**
   * El pin de ubicación de la clínica, mandado por una persona desde el chat
   * (el botón «Ubicación» sobre la caja de texto). Es el mismo pin que manda
   * la respuesta automática, pero esto SÍ es una respuesta: saca el chat de
   * «Sin responder» y reclama como cualquier envío —por eso reutiliza
   * `crearMensajeSaliente` en vez de `guardarMensajeAutomatico`—.
   *
   * Mismo contrato que `enviarMensaje`: visibilidad, ventana de 24 h (un pin
   * no es plantilla), idempotencia por `clientMessageId` y despacho sin
   * esperar a Meta. Si Meta rechaza el pin, el despachador manda el enlace
   * de Maps como texto; el historial guarda ese mismo texto.
   */
  async enviarUbicacion(conversacionId: string, agenteId: string, soloAgenteId?: string, clientMessageId?: string) {
    const conversacion = await obtenerConversacionPropia(this.prisma, conversacionId, soloAgenteId);
    await this.verificarVentana24h(conversacionId);

    let mensaje;
    try {
      [mensaje] = await this.crearMensajeSaliente(conversacionId, CONTENIDO_PIN, agenteId, undefined, clientMessageId);
    } catch (error) {
      const yaCreado = await recuperarEnvioDuplicado(this.prisma, this.logger, error, conversacionId, clientMessageId);
      if (!yaCreado) throw error;
      return { ...yaCreado, clienteTelefono: conversacion.cliente.telefono };
    }

    if (conversacion.linea.comercial) await this.clientesService
      .reclamarSiNoTieneDuena(conversacion.clienteId, agenteId, agenteId)
      .catch(error =>
        this.logger.error(`No se pudo reclamar la paciente ${conversacion.clienteId} para ${agenteId}`, error),
      );

    this.gateway.emitirActividad(conversacionId);

    void enSegundoPlano(`envío de la ubicación ${mensaje.id} a Meta`, this.logger, () =>
      this.despachador.ubicacion(
        { mensajeId: mensaje.id, conversacionId, telefono: conversacion.cliente.telefono },
        UBICACION_CLINICA,
        CONTENIDO_PIN,
      ),
    );

    return { ...mensaje, clienteTelefono: conversacion.cliente.telefono };
  }

  /**
   * «Reenviar» un mensaje de una persona que Meta rechazó, cuando la causa ya se
   * resolvió (ver `reenvio-manual.ts`). Mismo contrato que `enviarMensaje`:
   * visibilidad y ventana de 24 h. Es la MISMA fila: la paciente lo recibe una vez
   * y el hilo no muestra copias. No toca la conversación —ya contaba como
   * respondida desde el envío original—.
   */
  async reenviarMensaje(conversacionId: string, mensajeId: string, usuarioId: string, soloAgenteId?: string) {
    const conversacion = await obtenerConversacionPropia(this.prisma, conversacionId, soloAgenteId);
    const mensaje = await this.prisma.mensaje.findFirst({
      where: { id: mensajeId, conversacionId, direccion: 'SALIENTE' },
      select: {
        id: true, conversacionId: true, contenido: true, estadoEnvio: true, codigoErrorEnvio: true, intentosEnvio: true,
        automatico: true, plantillaCategoria: true, mediaKey: true, mediaMime: true, mediaNombre: true,
        interaccion: { select: { mensajeId: true } },
      },
    });
    if (!mensaje) throw new NotFoundException('Mensaje no encontrado en esta conversación');
    const motivo = motivoParaNoReenviar({ ...mensaje, tieneInteraccion: !!mensaje.interaccion });
    if (motivo) throw new BadRequestException(motivo);
    await this.verificarVentana24h(conversacionId);

    if (!(await reclamarReenvio(this.prisma, mensaje, usuarioId))) {
      throw new ConflictException('Ese mensaje ya se está reenviando.');
    }

    this.gateway.emitirActividad(conversacionId);
    const destino = { mensajeId: mensaje.id, conversacionId, telefono: conversacion.cliente.telefono };
    void enSegundoPlano(`reenvío del mensaje ${mensaje.id} a Meta`, this.logger, () =>
      mensaje.contenido === CONTENIDO_PIN && !mensaje.mediaKey
        ? this.despachador.ubicacion(destino, UBICACION_CLINICA, CONTENIDO_PIN)
        : this.despachador.texto(
          destino,
          mensaje.contenido,
          mensaje.mediaKey ? { key: mensaje.mediaKey, mime: mensaje.mediaMime, nombre: mensaje.mediaNombre } : undefined,
        ),
    );

    return { id: mensaje.id, estadoEnvio: 'INCIERTO' as const };
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
   *
   * `referencia` es el `biz_opaque_callback_data` que mandamos al enviar: el id
   * de nuestra propia fila. Es la segunda vía de correlación, y existe para un
   * caso concreto —F06 entrega 2—: cuando el envío se cortó sin respuesta HTTP,
   * la fila quedó INCIERTA y **sin** `whatsappMsgId`, así que por la vía normal
   * este status no encontraría a nadie y el mensaje se quedaría en duda para
   * siempre. Con la referencia se reconoce igual, se adopta el id que Meta
   * acaba de revelar, y la duda se cierra sin haber reenviado nada.
   */
  async procesarEstadoMensaje(
    whatsappMsgId: string,
    status: string,
    referencia?: string,
    lineaId?: string,
    codigoError?: number,
  ): Promise<void> {
    if (lineaId) {
      const reconocido = await this.prisma.mensaje.findFirst({ where: {
        conversacion: { lineaId },
        OR: [{ whatsappMsgId }, ...(referencia ? [{ id: referencia, whatsappMsgId: null }] : [])],
      }, select: { id: true } });
      if (!reconocido) return;
    }
    if (await estadoDeIntentoAnterior(this.prisma, referencia, whatsappMsgId)) return;
    let mensaje = await this.prisma.mensaje.findUnique({ where: { whatsappMsgId } });

    if (!mensaje && referencia) {
      mensaje = await this.adoptarIdDeMeta(referencia, whatsappMsgId);
    }

    if (!mensaje) {
      return; // status de un mensaje que no reconocemos (o llegó antes que el propio envío se guardara)
    }

    const ahora = new Date();
    if (status === 'read' && mensaje.estadoEnvio !== 'LEIDO') {
      await this.prisma.mensaje.updateMany({
        where: { id: mensaje.id },
        data: { estadoEnvio: 'LEIDO', codigoErrorEnvio: null, proximoIntento: null, leidoEn: mensaje.leidoEn ?? ahora, entregadoEn: mensaje.entregadoEn ?? ahora },
      });
    } else if (status === 'delivered' && mensaje.estadoEnvio !== 'LEIDO' && mensaje.estadoEnvio !== 'ENTREGADO') {
      await this.prisma.mensaje.updateMany({
        where: { id: mensaje.id, estadoEnvio: { not: 'LEIDO' } },
        data: { estadoEnvio: 'ENTREGADO', codigoErrorEnvio: null, proximoIntento: null, entregadoEn: ahora },
      });
    } else if (status === 'failed') {
      const codigo = codigoError ?? mensaje.codigoErrorEnvio;
      await this.prisma.mensaje.updateMany({
        where: { id: mensaje.id, whatsappMsgId, estadoEnvio: { notIn: ['ENTREGADO', 'LEIDO'] } },
        // El webhook no reinicia el contador ni posterga un fallo ya recibido.
        data: {
          estadoEnvio: 'FALLIDO', codigoErrorEnvio: codigo,
          proximoIntento: mensaje.permiteReintento && permiteReintentarError(codigo)
            ? mensaje.estadoEnvio === 'FALLIDO'
              ? mensaje.proximoIntento
              : proximoReintento(mensaje.intentosEnvio + 1)
            : null,
        },
      });
      /* Meta no entregó una plantilla porque ella paró las promociones desde
         WhatsApp. Si el webhook `user_preferences` se perdió —o la baja es
         anterior a suscribirlo— este es el único aviso: registrarla evita que
         la próxima campaña vuelva a pagar un intento que nunca llega. */
      if (codigo === ERROR_BAJA_MARKETING) {
        const { clienteId } = await this.prisma.conversacion.findUniqueOrThrow({
          where: { id: mensaje.conversacionId }, select: { clienteId: true },
        });
        await this.clientesService.registrarBajaPromociones(clienteId);
      }
    } else if (status === 'sent' && mensaje.estadoEnvio === 'INCIERTO') {
      /* La otra mitad de F06 entrega 2. Un 'sent' normalmente no aporta nada
         —la fila ya nace ENVIADO— pero sobre una fila INCIERTA es justo la
         respuesta que faltaba: sí salió. Sin esta rama, un envío cuya respuesta
         HTTP se perdió se quedaba en duda aunque Meta lo confirmara. */
      await this.prisma.mensaje.updateMany({
        where: { id: mensaje.id, estadoEnvio: 'INCIERTO' },
        data: { estadoEnvio: 'ENVIADO', codigoErrorEnvio: null, proximoIntento: null },
      });
    } else {
      return; // 'sent' sobre un envío que ya constaba, o repetido: nada nuevo
    }

    this.gateway.emitirActividad(mensaje.conversacionId);
  }

  /**
   * Le pone a la fila el id que Meta acaba de revelar por `biz_opaque_callback_data`.
   *
   * Solo actúa sobre una fila que **no tenga** id todavía: si ya lo tiene, el
   * status llegó por la vía normal y aquí no hay nada que arreglar. Se usa
   * `updateMany` con esa condición en el `where` —y no un `update` tras un
   * `findUnique`— porque `whatsappMsgId` es único y dos statuses del mismo
   * envío (sent y delivered llegan casi juntos) entrarían a la vez: de los dos,
   * exactamente uno adopta el id y el otro afecta cero filas sin romper nada.
   *
   * Devuelve la fila ya actualizada, o `null` si la referencia no correspondía
   * a ningún mensaje nuestro — Meta devuelve tal cual lo que le mandamos, pero
   * la conversación pudo haberse borrado entretanto.
   */
  private async adoptarIdDeMeta(referencia: string, whatsappMsgId: string) {
    const { count } = await this.prisma.mensaje.updateMany({
      where: { id: referencia, whatsappMsgId: null },
      data: { whatsappMsgId, proximoIntento: null },
    });

    if (count > 0) {
      this.logger.log(
        `Mensaje ${referencia}: Meta confirmó que sí salió (${whatsappMsgId}); se cierra el INCIERTO.`,
      );
    }

    return this.prisma.mensaje.findUnique({ where: { id: referencia } });
  }

  /**
   * Marca el último mensaje entrante como leído (tildes azules para el
   * paciente) y, si `typing`, muestra "escribiendo…". Se llama al abrir el
   * chat y mientras el agente redacta — así el paciente ve que lo atienden,
   * como en cualquier CRM de primer nivel. Fire-and-forget: nunca demora la UI.
   */
  async marcarLeido(conversacionId: string, soloAgenteId?: string, typing = false): Promise<{ ok: boolean }> {
    await obtenerConversacionPropia(this.prisma, conversacionId, soloAgenteId);

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
    const msgIdEntrante = ultimoEntrante?.whatsappMsgId;
    if (msgIdEntrante) {
      void enSegundoPlano('acuse de lectura hacia Meta', this.logger, () =>
        this.enviarEstadoLectura(msgIdEntrante, typing, conversacionId),
      );
    }
    return { ok: true };
  }

  /** Ver `marcarLeido`: se dispara sin await a propósito. */
  private async enviarEstadoLectura(whatsappMsgId: string, typing: boolean, conversacionId: string): Promise<void> {
    await this.whatsapp.marcarLeido(whatsappMsgId, typing, await this.lineas.cuentaDeConversacion(conversacionId));
  }

  /** Reasignar solo este chat; la atribución comercial del paciente no cambia. */
  async asignarAgente(conversacionId: string, agenteId: string | null, usuarioId?: string) {
    const conversacion = await this.prisma.conversacion.findUnique({
      where: { id: conversacionId },
      select: { id: true, clienteId: true, lineaId: true },
    });
    if (!conversacion) {
      throw new NotFoundException(`Conversación ${conversacionId} no encontrada`);
    }

    if (agenteId) {
      const agente = await this.prisma.usuario.findFirst({ where: { id: agenteId, activo: true, OR: [{ rol: { in: [...ROLES_ALCANCE_GLOBAL] } }, { lineasWhatsapp: { some: { lineaId: conversacion.lineaId } } }] } });
      if (!agente || !agente.activo) {
        throw new NotFoundException(`Agente ${agenteId} no encontrado o inactivo`);
      }
    }

    await this.prisma.$transaction([
      this.prisma.conversacion.update({ where: { id: conversacionId }, data: { agenteId } }),
      this.prisma.auditLog.create({ data: { entidad: 'Conversacion', entidadId: conversacionId, accion: 'AGENTE_ASIGNADO', usuarioId, cambios: { agenteId } } }),
    ]);
    this.gateway.emitirActividad(conversacionId);

    /* La respuesta incluye la identidad de la línea. */
    const actualizada = await this.prisma.conversacion.findUniqueOrThrow({
      where: { id: conversacionId },
      include: {
        linea: { select: SELECT_LINEA },
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
      agente: actualizada.agente,
    };
  }

  /** Lista de agentes activos — para el dropdown de asignación del admin (cacheada 30s). */
  async findAgentes() {
    return this.cacheAgentes.resolver(CLAVE_AGENTES, () =>
      this.prisma.usuario.findMany({
        where: { activo: true },
        select: { id: true, nombre: true, rol: true, lineasWhatsapp: { select: { lineaId: true } } },
        orderBy: { nombre: 'asc' },
      }),
    );
  }
}
