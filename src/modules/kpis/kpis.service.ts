import { Injectable } from '@nestjs/common';

import { CacheMemoria } from '../../common/cache/cache-memoria';
import { inicioDelDiaClinica, inicioDelMesClinica, ZONA_CLINICA } from '../../common/fechas/zona-clinica';
import { Prisma } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import { whereAccesoConversacion } from '../conversaciones/acceso-conversacion';
import { ESPERANDO_HUMANO } from '../conversaciones/atencion-humana';
import { SIN_RESPONDER } from '../conversaciones/estado-conversacion';
import { PeriodoKpi } from './dto/query-kpis.dto';

/** Un tramo de tiempo: `desde` incluido, `hasta` excluido. */
interface Rango {
  desde: Date;
  hasta: Date;
}

/** Fila del embudo por canal. `origen: null` es el total (GROUPING SETS). */
interface FilaEmbudo {
  origen: string | null;
  captados: number;
  respondidos: number;
  respondidosEnUnaHora: number;
  convertidos: number;
  medianaMinutos: number | null;
}

/** Cuánto esperaron los leads del periodo su primera respuesta humana. */
interface FilaEsperas {
  menos15: number;
  menosHora: number;
  menos4Horas: number;
  menosDia: number;
  masDia: number;
  sinRespuesta: number;
}

/** Leads por día de la semana (0 = lunes) y hora, en La Paz. Solo las celdas con alguno. */
interface FilaHora {
  dia: number;
  hora: number;
  leads: number;
}

interface FilaSerie {
  fecha: string;
  captados: number;
  respondidos: number;
  medianaMinutos: number | null;
  ventas: number;
}

/**
 * Módulo KPIs — RF-16/RF-17/RF-18. Solo lectura: agrega los demás dominios
 * para el dashboard.
 *
 * **El embudo se mide sobre los MENSAJES, no sobre `Lead.estado`.** Medido en
 * producción el 2026-09-22: 632 leads en NUEVO y ninguno, nunca, en
 * CONTACTADO — pero 234 de los 285 leads de septiembre ya habían recibido
 * respuesta de una persona, con una mediana de dos horas. Las agentes
 * contestan por WhatsApp y no mueven la tarjeta del Kanban. Un dashboard
 * leído del estado decía "632 por contactar" y "0 citas", que son dos
 * mentiras con forma de dato. «Respondido» es: existe un mensaje SALIENTE, no
 * automático (el acuse fuera de horario no es atención), posterior a la
 * creación del lead, en cualquier conversación de ese paciente.
 *
 * `CONVERTIDO` sí se sigue usando para «con venta»: lo marca `VentasService`
 * al registrar la venta, así que ese estado sí se mantiene solo.
 */
@Injectable()
export class KpisService {
  /**
   * 15 s: el dashboard se recarga al navegar, y nadie mira estos números al
   * segundo. La clave es el periodo con NOMBRE (tres valores) y el agente, así
   * que ya no hay fechas libres que la hagan crecer; el tope queda como red.
   */
  private readonly cache = new CacheMemoria<Awaited<ReturnType<KpisService['calcular']>>>({
    ttlMs: 15_000,
    maxEntradas: 50,
  });

  /** El análisis de abajo del Dashboard: más consultas y nadie lo mira al segundo. */
  private readonly cacheDetalle = new CacheMemoria<Awaited<ReturnType<KpisService['calcularDetalle']>>>({
    ttlMs: 60_000,
    maxEntradas: 50,
  });

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Lo que el Dashboard pinta bajo el pliegue (`GET /kpis/detalle`), aparte
   * del resumen para que lo de arriba no espere a esto: cuánto esperan los
   * leads su primera respuesta, a qué hora y qué día escriben, por qué línea
   * entran los chats, qué pacientes escriben (por categoría) y, para quien ve
   * todo, qué hizo el asistente. Mismo alcance por rol que el resumen.
   */
  async detalle(periodo: PeriodoKpi, soloAgenteId?: string, ahora = new Date()) {
    const clave = `${periodo}_${soloAgenteId ?? 'ALL'}`;
    return this.cacheDetalle.resolver(clave, () => this.calcularDetalle(periodo, soloAgenteId, ahora));
  }

  private async calcularDetalle(periodo: PeriodoKpi, soloAgenteId: string | undefined, ahora: Date) {
    const { actual } = rangosDe(periodo, ahora);
    const enActual = { gte: actual.desde, lt: actual.hasta };
    /* Chats del alcance que tuvieron un mensaje de la paciente en el periodo. */
    const conActividad: Prisma.ConversacionWhereInput = {
      AND: [whereAccesoConversacion(soloAgenteId), { mensajes: { some: { direccion: 'ENTRANTE', createdAt: enActual } } }],
    };

    const [esperas, porHora, porLinea, porCategoria, asistente] = await Promise.all([
      this.prisma.$queryRaw<FilaEsperas[]>`
        WITH base AS (${baseLeads(actual, soloAgenteId)})
        SELECT (count(*) FILTER (WHERE espera < interval '15 minutes'))::int AS "menos15",
               (count(*) FILTER (WHERE espera >= interval '15 minutes' AND espera < interval '1 hour'))::int AS "menosHora",
               (count(*) FILTER (WHERE espera >= interval '1 hour' AND espera < interval '4 hours'))::int AS "menos4Horas",
               (count(*) FILTER (WHERE espera >= interval '4 hours' AND espera < interval '24 hours'))::int AS "menosDia",
               (count(*) FILTER (WHERE espera >= interval '24 hours'))::int AS "masDia",
               (count(*) FILTER (WHERE espera IS NULL))::int AS "sinRespuesta"
          FROM base`,
      this.prisma.$queryRaw<FilaHora[]>`
        WITH base AS (${baseLeads(actual, soloAgenteId)})
        SELECT (extract(isodow FROM local)::int - 1) AS dia, extract(hour FROM local)::int AS hora, count(*)::int AS leads
          FROM base
         GROUP BY 1, 2`,
      this.prisma.conversacion.groupBy({ by: ['lineaId'], where: conActividad, _count: true }),
      this.prisma.cliente.groupBy({ by: ['categoria'], where: { conversaciones: { some: conActividad } }, _count: true }),
      /* El asistente no tiene dueño por agente: lo ve solo quien ve todo. */
      soloAgenteId
        ? Promise.resolve(null)
        : this.prisma.turnoAsistente.groupBy({ by: ['resultado'], where: { createdAt: enActual }, _count: true }),
    ]);

    const lineas = await this.prisma.lineaWhatsapp.findMany({
      where: { id: { in: porLinea.map(l => l.lineaId) } },
      select: { id: true, nombre: true },
    });
    const nombreDeLinea = new Map(lineas.map(l => [l.id, l.nombre]));
    const fila = esperas[0];

    return {
      primeraRespuesta: {
        menos15: fila?.menos15 ?? 0,
        menosHora: fila?.menosHora ?? 0,
        menos4Horas: fila?.menos4Horas ?? 0,
        menosDia: fila?.menosDia ?? 0,
        masDia: fila?.masDia ?? 0,
        sinRespuesta: fila?.sinRespuesta ?? 0,
      },
      porHora: porHora.sort((a, b) => a.dia - b.dia || a.hora - b.hora),
      chatsPorLinea: porLinea
        .map(l => ({ lineaId: l.lineaId, linea: nombreDeLinea.get(l.lineaId) ?? 'Línea', chats: l._count }))
        .sort((a, b) => b.chats - a.chats),
      pacientesPorCategoria: porCategoria
        .map(c => ({ categoria: c.categoria, pacientes: c._count }))
        .sort((a, b) => b.pacientes - a.pacientes),
      asistente: asistente && asistente.length
        ? Object.fromEntries(asistente.map(a => [a.resultado, a._count])) as Partial<Record<'SUGIRIO' | 'RESPONDIO' | 'DERIVO' | 'OMITIDO' | 'FALLO', number>>
        : null,
    };
  }

  /**
   * Alcance por rol: para un AGENTE, ventas se limitan a las suyas y leads y
   * chats a los suyos más el pool sin asignar. El `soloAgenteId` va en la
   * clave de caché: sin él, el resumen de un agente se serviría a otro.
   */
  async resumen(periodo: PeriodoKpi, soloAgenteId?: string, ahora = new Date()) {
    const clave = `${periodo}_${soloAgenteId ?? 'ALL'}`;
    return this.cache.resolver(clave, () => this.calcular(periodo, soloAgenteId, ahora));
  }

  private async calcular(periodo: PeriodoKpi, soloAgenteId: string | undefined, ahora: Date) {
    const { actual, anterior } = rangosDe(periodo, ahora);
    const enActual = { gte: actual.desde, lt: actual.hasta };
    const enAnterior = { gte: anterior.desde, lt: anterior.hasta };
    const leadsDelAlcance: Prisma.LeadWhereInput = {
      origen: { not: 'IMPORTACION' },
      ...(soloAgenteId ? { OR: [{ agenteId: soloAgenteId }, { agenteId: null }] } : {}),
    };
    const ventasGanadas = (createdAt: Prisma.DateTimeFilter): Prisma.VentaWhereInput => ({
      estado: 'GANADA',
      createdAt,
      agenteId: soloAgenteId,
    });

    const [
      embudo,
      embudoAnterior,
      serie,
      ventas,
      ventasAnterior,
      ventasPorAgente,
      topServicios,
      chatsSinResponder,
      chatsGoldSinResponder,
      leadsHoy,
      ultimasVentas,
      ultimosLeads,
      esperanPersona,
    ] = await Promise.all([
      this.embudo(actual, soloAgenteId),
      this.embudo(anterior, soloAgenteId),
      this.serie(actual, periodo === 'TRES_MESES' ? 'week' : 'day', soloAgenteId),
      this.prisma.venta.aggregate({ where: ventasGanadas(enActual), _sum: { monto: true }, _count: true }),
      this.prisma.venta.aggregate({ where: ventasGanadas(enAnterior), _sum: { monto: true }, _count: true }),
      this.prisma.venta.groupBy({
        by: ['agenteId'],
        where: ventasGanadas(enActual),
        _sum: { monto: true },
        _count: true,
      }),
      this.prisma.venta.groupBy({
        by: ['producto'],
        where: ventasGanadas(enActual),
        _sum: { monto: true },
        _count: true,
        orderBy: { _count: { producto: 'desc' } },
        take: 5,
      }),
      /* El MISMO where que la pestaña "Sin responder" del inbox: si el
         dashboard y el inbox dan dos números distintos, nadie cree a ninguno. */
      this.prisma.conversacion.count({
        where: { AND: [whereAccesoConversacion(soloAgenteId), SIN_RESPONDER] },
      }),
      /* Las Gold entre ellas: las que más valen no pueden esperar. Mismo where
         que el inbox con «★ Gold» en «Sin responder». */
      this.prisma.conversacion.count({
        where: { AND: [whereAccesoConversacion(soloAgenteId), SIN_RESPONDER, { cliente: { categoria: 'GOLD' } }] },
      }),
      this.prisma.lead.count({
        where: { ...leadsDelAlcance, createdAt: { gte: inicioDelDiaClinica(ahora) } },
      }),
      this.prisma.venta.findMany({
        where: { estado: 'GANADA', agenteId: soloAgenteId },
        select: {
          id: true,
          producto: true,
          monto: true,
          createdAt: true,
          cliente: { select: { nombre: true, telefono: true } },
          agente: { select: { nombre: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
      this.prisma.lead.findMany({
        where: leadsDelAlcance,
        select: {
          id: true,
          origen: true,
          createdAt: true,
          cliente: { select: { nombre: true, telefono: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
      /* Pidieron hablar con una persona y nadie la tomó: el mismo número que
         «Atención» en el inbox (en espera). */
      this.prisma.conversacion.count({ where: { AND: [whereAccesoConversacion(soloAgenteId), ESPERANDO_HUMANO] } }),
    ]);

    /* Nombre y foto del ranking en una consulta, cruzados por `agenteId` (la
       FK real de `Venta`), nunca por nombre. */
    const agentes = await this.prisma.usuario.findMany({
      where: { id: { in: ventasPorAgente.map(v => v.agenteId) } },
      select: { id: true, nombre: true, foto: true },
    });
    const agentePorId = new Map(agentes.map(a => [a.id, a]));

    const total = embudo.find(f => f.origen === null) ?? filaVacia();
    const totalAnterior = embudoAnterior.find(f => f.origen === null) ?? filaVacia();
    const montoVentas = Number(ventas._sum.monto ?? 0);

    const actividadReciente = [
      ...ultimasVentas.map(v => ({
        id: v.id,
        tipo: 'VENTA' as const,
        cliente: v.cliente,
        detalle: v.producto,
        agente: v.agente.nombre,
        monto: Number(v.monto),
        fecha: v.createdAt.toISOString(),
      })),
      ...ultimosLeads.map(l => ({
        id: l.id,
        tipo: 'LEAD' as const,
        cliente: l.cliente,
        detalle: l.origen,
        agente: null,
        monto: 0,
        fecha: l.createdAt.toISOString(),
      })),
    ]
      .sort((a, b) => b.fecha.localeCompare(a.fecha))
      .slice(0, 6);

    return {
      periodo: {
        clave: periodo,
        desde: actual.desde.toISOString(),
        hasta: actual.hasta.toISOString(),
        granularidad: periodo === 'TRES_MESES' ? ('SEMANA' as const) : ('DIA' as const),
      },
      /* Lo que pide acción AHORA. No depende del periodo elegido. */
      ahora: {
        chatsSinResponder,
        chatsGoldSinResponder,
        leadsHoy,
        esperanPersona,
      },
      embudo: {
        captados: total.captados,
        respondidos: total.respondidos,
        respondidosEnUnaHora: total.respondidosEnUnaHora,
        convertidos: total.convertidos,
        medianaRespuestaMinutos: redondear(total.medianaMinutos),
        anterior: {
          captados: totalAnterior.captados,
          respondidos: totalAnterior.respondidos,
          convertidos: totalAnterior.convertidos,
          medianaRespuestaMinutos: redondear(totalAnterior.medianaMinutos),
        },
      },
      serie,
      canales: embudo
        .filter(f => f.origen !== null)
        .map(f => ({
          origen: f.origen as string,
          captados: f.captados,
          respondidos: f.respondidos,
          convertidos: f.convertidos,
          medianaRespuestaMinutos: redondear(f.medianaMinutos),
        }))
        .sort((a, b) => b.captados - a.captados),
      ventas: {
        total: montoVentas,
        cantidad: ventas._count,
        ticketPromedio: ventas._count > 0 ? Math.round(montoVentas / ventas._count) : 0,
        anterior: {
          total: Number(ventasAnterior._sum.monto ?? 0),
          cantidad: ventasAnterior._count,
        },
        porAgente: ventasPorAgente
          .map(v => ({
            agenteId: v.agenteId,
            agente: agentePorId.get(v.agenteId)?.nombre ?? 'Desconocido',
            foto: agentePorId.get(v.agenteId)?.foto ?? null,
            cantidad: v._count,
            monto: Number(v._sum.monto ?? 0),
          }))
          .sort((a, b) => b.monto - a.monto),
      },
      topServicios: topServicios.map(s => ({
        producto: s.producto,
        cantidad: s._count,
        monto: Number(s._sum.monto ?? 0),
      })),
      actividadReciente,
    };
  }

  /**
   * Captados, respondidos por una persona, respondidos en la primera hora,
   * con venta y mediana de espera — por canal y en total, en UNA consulta
   * (`GROUPING SETS`: la mediana total no se puede sumar desde las de canal).
   *
   * Es SQL a mano porque «el primer mensaje humano POSTERIOR a la creación
   * del lead» compara dos columnas de filas distintas, y eso no se expresa en
   * un `where` de Prisma. Medido en producción: 31 ms para un mes, apoyado en
   * `Lead_createdAt_idx` y `Mensaje_conversacionId_createdAt_idx`.
   */
  private embudo(rango: Rango, soloAgenteId?: string): Promise<FilaEmbudo[]> {
    return this.prisma.$queryRaw<FilaEmbudo[]>`
      WITH base AS (${baseLeads(rango, soloAgenteId)})
      SELECT origen::text AS origen,
             count(*)::int AS captados,
             count(espera)::int AS respondidos,
             (count(*) FILTER (WHERE espera <= interval '1 hour'))::int AS "respondidosEnUnaHora",
             (count(*) FILTER (WHERE estado = 'CONVERTIDO'))::int AS convertidos,
             (percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM espera)) / 60)::float8 AS "medianaMinutos"
      FROM base
      GROUP BY GROUPING SETS ((origen), ())`;
  }

  /**
   * Por día (o por semana en tres meses), en el calendario de La Paz: leads,
   * respondidos, mediana de espera y monto vendido. Es lo que dibujan las
   * líneas de las tarjetas — que antes eran trazos fijos escritos a mano.
   *
   * Los huecos se rellenan: una serie con días ausentes dibuja una barra
   * pegada a la otra y parece que no hubo pausa. La mediana de un día sin
   * respuestas queda `null`, no cero: cero minutos sería la mejor marca.
   */
  private async serie(rango: Rango, tramo: 'day' | 'week', soloAgenteId?: string): Promise<FilaSerie[]> {
    const alcanceVentas = soloAgenteId ? Prisma.sql`AND v."agenteId" = ${soloAgenteId}` : Prisma.empty;
    const [leads, ventas] = await Promise.all([
      this.prisma.$queryRaw<Array<Omit<FilaSerie, 'ventas'>>>`
        WITH base AS (${baseLeads(rango, soloAgenteId)})
        SELECT to_char(date_trunc(${tramo}, local), 'YYYY-MM-DD') AS fecha,
               count(*)::int AS captados,
               count(espera)::int AS respondidos,
               (percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM espera)) / 60)::float8 AS "medianaMinutos"
        FROM base
        GROUP BY 1`,
      this.prisma.$queryRaw<Array<{ fecha: string; ventas: number }>>`
        SELECT to_char(date_trunc(${tramo}, (v."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${ZONA_CLINICA}), 'YYYY-MM-DD') AS fecha,
               sum(v.monto)::float8 AS ventas
          FROM "Venta" v
         WHERE v.estado = 'GANADA'
           AND v."createdAt" >= (${rango.desde.toISOString()}::timestamptz AT TIME ZONE 'UTC')
           AND v."createdAt" <  (${rango.hasta.toISOString()}::timestamptz AT TIME ZONE 'UTC')
           ${alcanceVentas}
         GROUP BY 1`,
    ]);
    const leadsPorFecha = new Map(leads.map(f => [f.fecha, f]));
    const ventasPorFecha = new Map(ventas.map(f => [f.fecha, f.ventas]));
    return fechasDelRango(rango, tramo).map(fecha => {
      const l = leadsPorFecha.get(fecha);
      return {
        fecha,
        captados: l?.captados ?? 0,
        respondidos: l?.respondidos ?? 0,
        medianaMinutos: redondear(l?.medianaMinutos ?? null),
        ventas: ventasPorFecha.get(fecha) ?? 0,
      };
    });
  }
}

/**
 * Los leads del rango con su espera hasta la primera respuesta humana
 * (`NULL` si nadie contestó). Las fechas viajan como texto ISO y se castean
 * aquí: `createdAt` es `timestamp` sin zona guardado en UTC, y comparar
 * contra un parámetro con zona dependería del `TimeZone` de la sesión.
 */
function baseLeads(rango: Rango, soloAgenteId?: string): Prisma.Sql {
  const alcance = soloAgenteId
    ? Prisma.sql`AND (l."agenteId" = ${soloAgenteId} OR l."agenteId" IS NULL)`
    : Prisma.empty;
  return Prisma.sql`
    SELECT l.origen,
           l.estado,
           (l."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${ZONA_CLINICA} AS local,
           (SELECT min(m."createdAt")
              FROM "Conversacion" c
              JOIN "Mensaje" m ON m."conversacionId" = c.id
             WHERE c."clienteId" = l."clienteId"
               AND m.direccion = 'SALIENTE'
               AND NOT m.automatico
               AND m."createdAt" >= l."createdAt") - l."createdAt" AS espera
      FROM "Lead" l
     WHERE l.origen <> 'IMPORTACION'
       AND l."createdAt" >= (${rango.desde.toISOString()}::timestamptz AT TIME ZONE 'UTC')
       AND l."createdAt" <  (${rango.hasta.toISOString()}::timestamptz AT TIME ZONE 'UTC')
       ${alcance}`;
}

/**
 * El periodo y el tramo con el que se compara. «Este mes» va hasta AHORA, así
 * que se compara con el mes anterior **hasta el mismo punto**: comparar diez
 * días contra un mes completo hace que todo mes en curso parezca una caída.
 */
export function rangosDe(periodo: PeriodoKpi, ahora: Date): { actual: Rango; anterior: Rango } {
  const inicioMes = inicioDelMesClinica(ahora);
  if (periodo === 'MES_ANTERIOR') {
    return {
      actual: { desde: inicioDelMesClinica(ahora, -1), hasta: inicioMes },
      anterior: { desde: inicioDelMesClinica(ahora, -2), hasta: inicioDelMesClinica(ahora, -1) },
    };
  }
  const meses = periodo === 'TRES_MESES' ? 3 : 1;
  const desde = inicioDelMesClinica(ahora, 1 - meses);
  const desdeAnterior = inicioDelMesClinica(ahora, 1 - 2 * meses);
  const transcurrido = ahora.getTime() - desde.getTime();
  return {
    actual: { desde, hasta: ahora },
    anterior: { desde: desdeAnterior, hasta: new Date(Math.min(desdeAnterior.getTime() + transcurrido, desde.getTime())) },
  };
}

/** Las etiquetas `YYYY-MM-DD` de cada tramo del rango, en el calendario de la clínica. */
function fechasDelRango(rango: Rango, tramo: 'day' | 'week'): string[] {
  const dia = new Intl.DateTimeFormat('en-CA', { timeZone: ZONA_CLINICA, year: 'numeric', month: '2-digit', day: '2-digit' });
  const fechas: string[] = [];
  /* Mediodía en UTC del primer día local: lejos de cualquier borde de zona. */
  const cursor = new Date(`${dia.format(rango.desde)}T12:00:00Z`);
  if (tramo === 'week') {
    /* `date_trunc('week')` de PostgreSQL empieza en lunes. */
    cursor.setUTCDate(cursor.getUTCDate() - ((cursor.getUTCDay() + 6) % 7));
  }
  const ultimo = dia.format(new Date(rango.hasta.getTime() - 1));
  while (cursor.toISOString().slice(0, 10) <= ultimo) {
    fechas.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + (tramo === 'week' ? 7 : 1));
  }
  return fechas;
}

function filaVacia(): FilaEmbudo {
  return { origen: null, captados: 0, respondidos: 0, respondidosEnUnaHora: 0, convertidos: 0, medianaMinutos: null };
}

function redondear(minutos: number | null): number | null {
  return minutos === null ? null : Math.round(minutos);
}
