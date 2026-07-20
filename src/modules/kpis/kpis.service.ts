import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';

/**
 * Módulo KPIs — RF-16/RF-17/RF-18.
 * Solo lectura: agrega datos de los demás dominios para el dashboard.
 */
@Injectable()
export class KpisService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Alcance por rol: para un AGENTE, ventas y comisiones se limitan a las suyas
   * (soloAgenteId); los agregados de leads/clientes son globales para ambos roles.
   */
  async resumen(desde?: string, hasta?: string, soloAgenteId?: string) {
    const rango = {
      gte: desde ? new Date(desde) : undefined,
      lte: hasta ? new Date(hasta) : undefined,
    };

    const [
      ventasGanadas,
      ventasPorAgente,
      leadsPorOrigen,
      leadsConvertidosPorOrigen,
      clientesPorCategoria,
      comisiones,
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
      this.prisma.comision.groupBy({
        by: ['estado'],
        where: { createdAt: rango, agenteId: soloAgenteId },
        _sum: { monto: true },
      }),
    ]);

    /* Nombres de agentes para el ranking (una sola consulta) */
    const agentes = await this.prisma.usuario.findMany({
      where: { id: { in: ventasPorAgente.map(v => v.agenteId) } },
      select: { id: true, nombre: true },
    });
    const nombrePorId = new Map(agentes.map(a => [a.id, a.nombre]));

    return {
      ventas: {
        total: Number(ventasGanadas._sum.monto ?? 0),
        cantidad: ventasGanadas._count,
        porAgente: ventasPorAgente
          .map(v => ({
            agenteId: v.agenteId,
            agente: nombrePorId.get(v.agenteId) ?? 'Desconocido',
            cantidad: v._count,
            monto: Number(v._sum.monto ?? 0),
          }))
          .sort((a, b) => b.monto - a.monto),
      },
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
      comisiones: {
        pendiente: Number(comisiones.find(c => c.estado === 'PENDIENTE')?._sum.monto ?? 0),
        pagada: Number(comisiones.find(c => c.estado === 'PAGADA')?._sum.monto ?? 0),
      },
    };
  }
}
