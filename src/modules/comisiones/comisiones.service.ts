import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, Venta } from '@prisma/client';

import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { QueryComisionDto } from './dto/query-comision.dto';
import { calcularPaginacion, paginar } from '../../common/dto/pagination.dto';

/**
 * Módulo Comisiones — RF-13/RF-14/RF-15.
 * La comisión se genera automáticamente al registrar una venta ganada
 * (invocado por VentasService). El porcentaje sale de COMISION_PORCENTAJE
 * en .env (RF-22: regla ajustable por admin sin tocar código).
 * Los agentes nunca editan comisiones: solo un ADMIN marca el pago.
 */
@Injectable()
export class ComisionesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  private get porcentaje(): number {
    return Number(this.config.get('COMISION_PORCENTAJE') ?? 5);
  }

  /** Idempotente: si la venta ya tiene comisión, no duplica. */
  async generarParaVenta(venta: Venta): Promise<void> {
    const existente = await this.prisma.comision.findUnique({ where: { ventaId: venta.id } });
    if (existente) {
      return;
    }

    const monto = (Number(venta.monto) * this.porcentaje) / 100;
    const comision = await this.prisma.comision.create({
      data: {
        ventaId: venta.id,
        agenteId: venta.agenteId,
        monto,
      },
    });

    await this.audit.registrar('Comision', comision.id, 'GENERADA_AUTO', undefined, {
      ventaId: venta.id,
      porcentaje: this.porcentaje,
      monto,
    });
  }

  async findAll(query: QueryComisionDto) {
    const where: Prisma.ComisionWhereInput = {
      estado: query.estado,
      agenteId: query.agenteId,
      createdAt: {
        gte: query.desde ? new Date(query.desde) : undefined,
        lte: query.hasta ? new Date(query.hasta) : undefined,
      },
    };
    const { skip, take } = calcularPaginacion(query);

    const [datos, total] = await this.prisma.$transaction([
      this.prisma.comision.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: {
          agente: { select: { id: true, nombre: true } },
          venta: { select: { id: true, producto: true, monto: true, createdAt: true } },
        },
        skip,
        take,
      }),
      this.prisma.comision.count({ where }),
    ]);

    return paginar(datos, total, query);
  }

  /** RF-14 — solo ADMIN (garantizado en el controller). */
  async marcarPagada(id: string, adminId: string) {
    const comision = await this.prisma.comision.findUnique({ where: { id } });
    if (!comision) {
      throw new NotFoundException(`Comisión ${id} no encontrada`);
    }

    const actualizada = await this.prisma.comision.update({
      where: { id },
      data: { estado: 'PAGADA', pagadaEn: new Date() },
    });

    await this.audit.registrar('Comision', id, 'MARCADA_PAGADA', adminId);
    return actualizada;
  }
}
