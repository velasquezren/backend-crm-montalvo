import { Injectable } from '@nestjs/common';

import { CacheMemoria } from '../../common/cache/cache-memoria';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Módulo KPIs — RF-16/RF-17/RF-18.
 * Solo lectura: agrega datos de los demás dominios para el dashboard.
 */
@Injectable()
export class KpisService {
  /**
   * 15 s: el dashboard se recarga al navegar y ocho consultas agregadas por
   * visita es caro para un dato que nadie mira al segundo.
   *
   * El tope de entradas **no es decorativo**: la clave incluye `desde`/`hasta`,
   * que llegan libres por query param, así que sin él cada rango que alguien
   * eligiera en el calendario se quedaba en memoria para siempre. Era una fuga.
   */
  private readonly cache = new CacheMemoria<Awaited<ReturnType<KpisService['calcular']>>>({
    ttlMs: 15_000,
    maxEntradas: 50,
  });

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Alcance por rol: para un AGENTE, ventas y comisiones se limitan a las suyas
   * (soloAgenteId); los agregados de leads/clientes son globales para ambos roles.
   *
   * El `soloAgenteId` va en la clave de caché a propósito: sin él, el resumen
   * de un agente se serviría a otro durante 15 s — el mismo agujero de escopado
   * que el `resumen()` tenía en las consultas.
   */
  async resumen(desde?: string, hasta?: string, soloAgenteId?: string) {
    const clave = `${desde ?? ''}_${hasta ?? ''}_${soloAgenteId ?? 'ALL'}`;
    return this.cache.resolver(clave, () => this.calcular(desde, hasta, soloAgenteId));
  }

  private async calcular(desde?: string, hasta?: string, soloAgenteId?: string) {
    const rango = {
      gte: desde ? new Date(desde) : undefined,
      lte: hasta ? new Date(hasta) : undefined,
    };

    const hoyInicio = new Date();
    hoyInicio.setHours(0, 0, 0, 0);

    const [
      ventasGanadas,
      ventasPorAgente,
      leadsPorOrigen,
      leadsConvertidosPorOrigen,
      clientesPorCategoria,
      totalConversaciones,
      leadsContactados,
      // Pulso operativo de hoy / tiempo real
      leadsHoyCount,
      ventasHoy,
      leadsNuevosSinAtender,
      conversacionesActivas,
      topServiciosVenta,
      ultimasVentas,
      ultimosLeads,
    ] = await Promise.all([
      this.prisma.venta.aggregate({
        where: { estado: 'GANADA', createdAt: rango, agenteId: soloAgenteId },
        _sum: { monto: true },
        _count: true,
      }),
      this.prisma.venta.groupBy({
        by: ['agenteId'],
        where: { estado: 'GANADA', createdAt: rango, agenteId: soloAgenteId },
        _sum: { monto: true },
        _count: true,
      }),
      this.prisma.lead.groupBy({
        by: ['origen'],
        where: { createdAt: rango },
        _count: true,
      }),
      this.prisma.lead.groupBy({
        by: ['origen'],
        where: { createdAt: rango, estado: 'CONVERTIDO' },
        _count: true,
      }),
      this.prisma.cliente.groupBy({
        by: ['categoria'],
        _count: true,
      }),
      /* Escopadas por soloAgenteId igual que ventas arriba */
      this.prisma.conversacion.count({
        where: soloAgenteId
          ? { OR: [{ agenteId: soloAgenteId }, { agenteId: null }] }
          : undefined,
      }),
      this.prisma.lead.count({
        where: {
          estado: 'CONTACTADO',
          origen: { not: 'IMPORTACION' },
          ...(soloAgenteId ? { OR: [{ agenteId: soloAgenteId }, { agenteId: null }] } : {}),
        },
      }),
      // Métricas de hoy
      this.prisma.lead.count({
        where: {
          createdAt: { gte: hoyInicio },
          origen: { not: 'IMPORTACION' },
          ...(soloAgenteId ? { OR: [{ agenteId: soloAgenteId }, { agenteId: null }] } : {}),
        },
      }),
      this.prisma.venta.aggregate({
        where: {
          estado: 'GANADA',
          createdAt: { gte: hoyInicio },
          agenteId: soloAgenteId,
        },
        _sum: { monto: true },
        _count: true,
      }),
      this.prisma.lead.count({
        where: {
          estado: 'NUEVO',
          origen: { not: 'IMPORTACION' },
          ...(soloAgenteId ? { OR: [{ agenteId: soloAgenteId }, { agenteId: null }] } : {}),
        },
      }),
      this.prisma.conversacion.count({
        where: {
          updatedAt: { gte: hoyInicio },
          ...(soloAgenteId ? { OR: [{ agenteId: soloAgenteId }, { agenteId: null }] } : {}),
        },
      }),
      this.prisma.venta.groupBy({
        by: ['producto'],
        where: { estado: 'GANADA', createdAt: rango, agenteId: soloAgenteId },
        _sum: { monto: true },
        _count: true,
        orderBy: { _count: { producto: 'desc' } },
        take: 6,
      }),
      this.prisma.venta.findMany({
        where: { estado: 'GANADA', ...(soloAgenteId ? { agenteId: soloAgenteId } : {}) },
        select: {
          id: true,
          producto: true,
          monto: true,
          createdAt: true,
          cliente: { select: { nombre: true } },
          agente: { select: { nombre: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
      this.prisma.lead.findMany({
        where: {
          origen: { not: 'IMPORTACION' },
          ...(soloAgenteId ? { OR: [{ agenteId: soloAgenteId }, { agenteId: null }] } : {}),
        },
        select: {
          id: true,
          origen: true,
          estado: true,
          createdAt: true,
          cliente: { select: { nombre: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
    ]);

    /* Nombres de agentes para el ranking (una sola consulta) */
    const agentes = await this.prisma.usuario.findMany({
      where: { id: { in: ventasPorAgente.map(v => v.agenteId) } },
      select: { id: true, nombre: true },
    });
    const nombrePorId = new Map(agentes.map(a => [a.id, a.nombre]));

    const actividadVentas = ultimasVentas.map(v => ({
      id: v.id,
      tipo: 'VENTA' as const,
      titulo: `Venta cerrada: ${v.producto}`,
      subtitulo: `${v.cliente.nombre} · Atendido por ${v.agente.nombre}`,
      monto: Number(v.monto),
      fecha: v.createdAt.toISOString(),
    }));

    const actividadLeads = ultimosLeads.map(l => ({
      id: l.id,
      tipo: 'LEAD' as const,
      titulo: `Nuevo prospecto: ${l.cliente.nombre}`,
      subtitulo: `Canal: ${l.origen.replace(/_/g, ' ')} · Estado: ${l.estado}`,
      monto: 0,
      fecha: l.createdAt.toISOString(),
    }));

    const actividadReciente = [...actividadVentas, ...actividadLeads]
      .sort((a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime())
      .slice(0, 7);

    return {
      pulsoHoy: {
        leadsHoy: leadsHoyCount,
        ventasHoyMonto: Number(ventasHoy._sum.monto ?? 0),
        ventasHoyCantidad: ventasHoy._count,
        leadsNuevosSinAtender,
        conversacionesActivas,
      },
      ventas: {
        total: Number(ventasGanadas._sum.monto ?? 0),
        cantidad: ventasGanadas._count,
        ticketPromedio: ventasGanadas._count > 0 ? Math.round(Number(ventasGanadas._sum.monto ?? 0) / ventasGanadas._count) : 0,
        porAgente: ventasPorAgente
          .map(v => ({
            agenteId: v.agenteId,
            agente: nombrePorId.get(v.agenteId) ?? 'Desconocido',
            cantidad: v._count,
            monto: Number(v._sum.monto ?? 0),
          }))
          .sort((a, b) => b.monto - a.monto),
      },
      topServicios: topServiciosVenta.map(s => ({
        producto: s.producto,
        cantidad: s._count,
        monto: Number(s._sum.monto ?? 0),
      })),
      actividadReciente,
      /* RF-17 — tasa de conversión de leads a ventas, por canal de origen */
      leadsPorOrigen: leadsPorOrigen.map(l => {
        const convertidos =
          leadsConvertidosPorOrigen.find(c => c.origen === l.origen)?._count ?? 0;
        return {
          origen: l.origen,
          cantidad: l._count,
          convertidos,
          tasaConversion: l._count > 0 ? Math.round((convertidos / l._count) * 100) : 0,
        };
      }),
      clientesPorCategoria: clientesPorCategoria.map(c => ({
        categoria: c.categoria,
        cantidad: c._count,
      })),
      funnel: {
        conversacionesTotal: totalConversaciones,
        leadsContactados: leadsContactados,
      },
    };
  }
}
