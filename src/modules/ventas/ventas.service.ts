import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EstadoVenta, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';

import { AuditService } from '../../common/audit/audit.service';
import { R2Service } from '../../common/storage/r2.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientesService } from '../clientes/clientes.service';
import { ComisionesService } from '../comisiones/comisiones.service';
import { LeadsService } from '../leads/leads.service';
import { ArchivoSubido } from './archivo-subido';
import { CreateVentaDto } from './dto/create-venta.dto';
import { QueryVentaDto } from './dto/query-venta.dto';
import { calcularPaginacion, paginar } from '../../common/dto/pagination.dto';

/**
 * Módulo Ventas — RF-11/RF-12.
 * Una venta GANADA dispara (vía services de otros módulos, nunca su BD):
 *   1. ComisionesService.generarParaVenta()  → comisión automática (RF-13)
 *   2. ClientesService.actualizarCategoria() → recategorización (RF-21)
 *   3. LeadsService.marcarConvertidos()      → cierre automático de oportunidades
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
    private readonly r2: R2Service,
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
        estado: dto.estado ?? 'GANADA',
        metodoPago: dto.metodoPago ?? null,
        comprobante: dto.comprobante ?? null,
        comprobanteKey: dto.comprobanteKey ?? null,
        comprobanteMime: dto.comprobanteMime ?? null,
        comprobanteNombre: dto.comprobanteNombre ?? null,
        medico: dto.medico ?? null,
        modulo: dto.modulo ?? null,
        notas: dto.notas ?? null,
      },
      include: {
        cliente: { select: { id: true, nombre: true, telefono: true } },
        agente: { select: { id: true, nombre: true } },
      },
    });

    await this.audit.registrar('Venta', venta.id, 'CREADA', agenteId, {
      producto: venta.producto,
      monto: Number(venta.monto),
      estado: venta.estado,
      metodoPago: venta.metodoPago,
      comprobante: venta.comprobante,
      modulo: venta.modulo,
      medico: venta.medico,
    });

    if (venta.estado === 'GANADA') {
      await this.comisionesService.generarParaVenta(venta);
      await this.clientesService.actualizarCategoria(venta.clienteId);
      await this.leadsService.marcarConvertidos(venta.clienteId);
    }

    const comprobanteUrl = venta.comprobanteKey ? await this.r2.urlFirmada(venta.comprobanteKey) : null;
    return { ...venta, comprobanteUrl };
  }

  async subirComprobante(file: ArchivoSubido, usuarioId: string) {
    if (!this.r2.habilitado) {
      throw new BadRequestException('El almacenamiento de comprobantes no está disponible');
    }
    if (file.size > 8 * 1024 * 1024) {
      throw new BadRequestException('El comprobante supera el límite de 8 MB');
    }

    const idTemp = randomUUID();
    const extension = file.originalname.split('.').pop() || 'bin';
    const comprobanteKey = `comprobantes/${usuarioId}/${idTemp}.${extension}`;
    const ab = file.buffer.buffer.slice(
      file.buffer.byteOffset,
      file.buffer.byteOffset + file.buffer.byteLength,
    ) as ArrayBuffer;

    await this.r2.subir(comprobanteKey, ab, file.mimetype);
    const comprobanteUrl = await this.r2.urlFirmada(comprobanteKey);

    return {
      comprobanteKey,
      comprobanteMime: file.mimetype,
      comprobanteNombre: file.originalname,
      comprobanteUrl,
    };
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
          cliente: { select: { id: true, nombre: true, telefono: true, pac: true } },
          agente: { select: { id: true, nombre: true } },
          comision: { select: { id: true, monto: true, estado: true } },
        },
        skip,
        take,
      }),
      this.prisma.venta.count({ where }),
    ]);

    const datosConUrl = await Promise.all(
      datos.map(async v => ({
        ...v,
        comprobanteUrl: v.comprobanteKey ? await this.r2.urlFirmada(v.comprobanteKey) : null,
      })),
    );

    return paginar(datosConUrl, total, query);
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

    if (estado === 'GANADA' && venta.estado !== 'GANADA') {
      await this.comisionesService.generarParaVenta(actualizada);
      await this.clientesService.actualizarCategoria(actualizada.clienteId);
      await this.leadsService.marcarConvertidos(actualizada.clienteId);
    }

    const comprobanteUrl = actualizada.comprobanteKey ? await this.r2.urlFirmada(actualizada.comprobanteKey) : null;
    return { ...actualizada, comprobanteUrl };
  }
}
