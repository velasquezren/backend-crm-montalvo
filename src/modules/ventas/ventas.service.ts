import { Injectable, NotFoundException } from '@nestjs/common';
import { EstadoVenta, Prisma } from '@prisma/client';

import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientesService } from '../clientes/clientes.service';
import { ComisionesService } from '../comisiones/comisiones.service';
import { LeadsService } from '../leads/leads.service';
import { CreateVentaDto } from './dto/create-venta.dto';
import { QueryVentaDto } from './dto/query-venta.dto';
import { calcularPaginacion, paginar } from '../../common/dto/pagination.dto';

/**
 * Módulo Ventas — RF-11/RF-12.
 * Una venta GANADA dispara (vía services de otros módulos, nunca su BD):
 *   1. ComisionesService.generarParaVenta()  → comisión automática (RF-13)
 *   2. ClientesService.actualizarCategoria() → recategorización (RF-21)
 * El agente que cierra queda fijado desde el JWT y no existe endpoint para cambiarlo.
 */
@Injectable()
export class VentasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clientesService: ClientesService,
    private readonly comisionesService: ComisionesService,
    private readonly leadsService: LeadsService,
    private readonly audit: AuditService,
  ) {}

  async create(dto: CreateVentaDto, agenteId: string) {
    /* valida que el cliente exista (lanza 404 si no) */
    await this.clientesService.findOne(dto.clienteId);

    const venta = await this.prisma.venta.create({
      data: {
        clienteId: dto.clienteId,
        agenteId,
        producto: dto.producto,
        monto: dto.monto,
        estado: dto.estado,
      },
    });

    await this.audit.registrar('Venta', venta.id, 'CREADA', agenteId, {
      producto: venta.producto,
      monto: Number(venta.monto),
      estado: venta.estado,
    });

    if (venta.estado === 'GANADA') {
      await this.comisionesService.generarParaVenta(venta);
      await this.clientesService.actualizarCategoria(venta.clienteId);
      await this.leadsService.marcarConvertidos(venta.clienteId);
    }

    return venta;
  }

  async findAll(query: QueryVentaDto) {
    const where: Prisma.VentaWhereInput = {
      estado: query.estado,
      agenteId: query.agenteId,
      createdAt: {
        gte: query.desde ? new Date(query.desde) : undefined,
        lte: query.hasta ? new Date(query.hasta) : undefined,
      },
    };
    const { skip, take } = calcularPaginacion(query);

    const [datos, total] = await this.prisma.$transaction([
      this.prisma.venta.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: {
          cliente: { select: { id: true, nombre: true, telefono: true } },
          agente: { select: { id: true, nombre: true } },
          comision: { select: { id: true, monto: true, estado: true } },
        },
        skip,
        take,
      }),
      this.prisma.venta.count({ where }),
    ]);

    return paginar(datos, total, query);
  }

  /** Cambio de estado (solo ADMIN, garantizado en el controller) — RF-12: el agente no se toca. */
  async cambiarEstado(id: string, estado: EstadoVenta, adminId: string) {
    const venta = await this.prisma.venta.findUnique({ where: { id } });
    if (!venta) {
      throw new NotFoundException(`Venta ${id} no encontrada`);
    }

    const actualizada = await this.prisma.venta.update({ where: { id }, data: { estado } });
    await this.audit.registrar('Venta', id, 'CAMBIO_ESTADO', adminId, {
      de: venta.estado,
      a: estado,
    });

    if (estado === 'GANADA') {
      await this.comisionesService.generarParaVenta(actualizada);
      await this.clientesService.actualizarCategoria(actualizada.clienteId);
      await this.leadsService.marcarConvertidos(actualizada.clienteId);
    }

    return actualizada;
  }
}
