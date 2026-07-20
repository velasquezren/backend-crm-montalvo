import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

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

  async historial(entidad: string, entidadId: string) {
    return this.prisma.auditLog.findMany({
      where: { entidad, entidadId },
      orderBy: { createdAt: 'desc' },
    });
  }
}
