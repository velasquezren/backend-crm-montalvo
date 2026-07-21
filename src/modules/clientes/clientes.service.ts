import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CategoriaCliente, Prisma } from '@prisma/client';

import { AuditService } from '../../common/audit/audit.service';
import { calcularPaginacion, paginar } from '../../common/dto/pagination.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateClienteDto } from './dto/create-cliente.dto';
import { CreateInteresDto } from './dto/create-interes.dto';
import { QueryClienteDto } from './dto/query-cliente.dto';
import { UpdateClienteDto } from './dto/update-cliente.dto';

/**
 * Módulo Clientes — dueño exclusivo de la entidad Cliente/Interes y de la
 * categorización (CRM_MANIFESTO.md §5). Otros módulos (ventas, leads,
 * conversaciones) deben llamar a estos métodos públicos, nunca tocar
 * `prisma.cliente` directamente.
 */
@Injectable()
export class ClientesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(dto: CreateClienteDto) {
    const existente = await this.prisma.cliente.findUnique({ where: { telefono: dto.telefono } });
    if (existente) {
      throw new ConflictException(`Ya existe un cliente con el teléfono ${dto.telefono}`);
    }

    return this.prisma.cliente.create({
      data: {
        nombre: dto.nombre,
        telefono: dto.telefono,
        email: dto.email,
        categoria: dto.categoria,
        agenteId: dto.agenteId,
        datosExtra: dto.datosExtra as Prisma.InputJsonValue | undefined,
      },
    });
  }

  /**
   * Visibilidad por rol: un AGENTE ve sus clientes asignados y el pool sin
   * asignar (la asignación es manual en v1); un ADMIN ve todo — se controla
   * pasando (o no) soloAgenteId desde el controller.
   */
  async findAll(query: QueryClienteDto, soloAgenteId?: string) {
    const where: Prisma.ClienteWhereInput = {
      categoria: query.categoria,
      ...(soloAgenteId ? { OR: [{ agenteId: soloAgenteId }, { agenteId: null }] } : {}),
      ...(query.busqueda
        ? {
            AND: {
              OR: [
                { nombre: { contains: query.busqueda, mode: 'insensitive' } },
                { telefono: { contains: query.busqueda } },
                { email: { contains: query.busqueda, mode: 'insensitive' } },
              ],
            },
          }
        : {}),
    };

    const { skip, take } = calcularPaginacion(query);

    /* Una sola ida a la base: página + total, en paralelo. */
    const [datos, total] = await this.prisma.$transaction([
      this.prisma.cliente.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        include: {
          intereses: { orderBy: { createdAt: 'desc' }, take: 5 },
          agente: { select: { id: true, nombre: true } },
        },
        skip,
        take,
      }),
      this.prisma.cliente.count({ where }),
    ]);

    return paginar(datos, total, query);
  }

  async findOne(id: string) {
    const cliente = await this.prisma.cliente.findUnique({
      where: { id },
      include: {
        intereses: { orderBy: { createdAt: 'desc' } },
        leads: { orderBy: { createdAt: 'desc' } },
        ventas: { orderBy: { createdAt: 'desc' } },
      },
    });

    if (!cliente) {
      throw new NotFoundException(`Cliente ${id} no encontrado`);
    }
    return cliente;
  }

  async findByTelefono(telefono: string) {
    return this.prisma.cliente.findUnique({ where: { telefono } });
  }

  async update(id: string, dto: UpdateClienteDto, usuarioId?: string) {
    await this.findOne(id);
    const actualizado = await this.prisma.cliente.update({
      where: { id },
      data: {
        ...dto,
        datosExtra: dto.datosExtra as Prisma.InputJsonValue | undefined,
      },
    });

    await this.audit.registrar('Cliente', id, 'ACTUALIZADO', usuarioId, { ...dto });
    return actualizado;
  }

  /** RF-23 — registra una consulta que no derivó en venta, sin exponer la tabla a otros módulos. */
  async registrarInteres(clienteId: string, dto: CreateInteresDto) {
    await this.findOne(clienteId);
    return this.prisma.interes.create({
      data: { ...dto, clienteId },
    });
  }

  /**
   * RF-21 — recalcula la categoría del cliente según su historial de ventas ganadas.
   * Regla por defecto (ajustable por un admin a futuro, RF-22):
   *   GOLD   ≥ 3 ventas ganadas o monto acumulado ≥ 10 000 Bs en los últimos 90 días
   *   SILVER 1-2 ventas ganadas
   *   BRONZE cliente con ventas pero fuera de la ventana de 90 días
   *   PROSPECTO sin ventas ganadas
   */
  async actualizarCategoria(clienteId: string): Promise<CategoriaCliente> {
    const hace90Dias = new Date();
    hace90Dias.setDate(hace90Dias.getDate() - 90);

    /* Se agrega en SQL en vez de traer todas las ventas del cliente a memoria
       para filtrarlas y sumarlas en JS: la base solo devuelve 3 números. */
    const [recientes, historicas] = await this.prisma.$transaction([
      this.prisma.venta.aggregate({
        where: { clienteId, estado: 'GANADA', createdAt: { gte: hace90Dias } },
        _count: true,
        _sum: { monto: true },
      }),
      this.prisma.venta.count({ where: { clienteId, estado: 'GANADA' } }),
    ]);

    const cantidadReciente = recientes._count;
    const montoReciente = Number(recientes._sum.monto ?? 0);

    let categoria: CategoriaCliente = 'PROSPECTO';
    if (cantidadReciente >= 3 || montoReciente >= 10_000) {
      categoria = 'GOLD';
    } else if (cantidadReciente >= 1) {
      categoria = 'SILVER';
    } else if (historicas >= 1) {
      categoria = 'BRONZE';
    }

    await this.prisma.cliente.update({ where: { id: clienteId }, data: { categoria } });
    return categoria;
  }
}
