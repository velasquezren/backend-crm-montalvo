import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { calcularPaginacion, paginar, PaginationDto } from '../dto/pagination.dto';

/**
 * Bitácora de cambios — RF-19/RF-20, RNF-05.
 * Los módulos llaman registrar() en cada mutación crítica (ventas, comisiones,
 * clientes). Nunca falla la operación principal si la auditoría falla.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async registrar(
    entidad: string,
    entidadId: string,
    accion: string,
    usuarioId?: string,
    cambios?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          entidad,
          entidadId,
          accion,
          usuarioId,
          cambios: cambios as Prisma.InputJsonValue | undefined,
        },
      });
    } catch {
      /* la auditoría no debe tumbar la operación de negocio */
    }
  }

  async historial(entidad: string, entidadId: string, query: PaginationDto = {}) {
    const where = { entidad, entidadId };
    const { skip, take } = calcularPaginacion(query);

    const [datos, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.auditLog.count({ where }),
    ]);

    return paginar(datos, total, query);
  }
}
