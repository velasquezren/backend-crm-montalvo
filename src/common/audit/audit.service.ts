import { Injectable } from '@nestjs/common';
import { Prisma } from '../../prisma/prisma-client';

import { PrismaService } from '../../prisma/prisma.service';
import { calcularPaginacion, paginar, PaginationDto } from '../dto/pagination.dto';

/**
 * Bitácora de cambios — RF-19/RF-20, RNF-05.
 * registrar() conserva el contrato best-effort de los módulos existentes.
 * Los hechos financieros usan registrarFinanciero() en su transacción.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}
  readonly registrarFinanciero = AuditService.registrarFinanciero;

  /** Si falta esta evidencia, la operación financiera tampoco se confirma. */
  static async registrarFinanciero(
    tx: Prisma.TransactionClient,
    entidad: string,
    entidadId: string,
    accion: string,
    usuarioId?: string,
    cambios?: Record<string, unknown>,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        entidad, entidadId, accion, usuarioId,
        // Fotos Prisma contienen Date/Decimal: guardar sus valores JSON,
        // no objetos de runtime ni undefined dentro del documento.
        cambios: cambios === undefined ? undefined : JSON.parse(JSON.stringify(cambios)) as Prisma.InputJsonValue,
      },
    });
  }

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
