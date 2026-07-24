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

  /**
   * @param soloAgenteId Si viene (usuario AGENTE, no ADMIN), solo puede ver
   *   clientes propios o del pool sin asignar — la misma regla de `findAll`.
   *   Sin esto, cualquier agente autenticado podía leer la ficha de CUALQUIER
   *   cliente por ID sabiendo el UUID, sin importar a quién estaba asignado.
   *   404 en vez de 403 para no confirmar que el registro existe.
   */
  async findOne(id: string, soloAgenteId?: string) {
    const cliente = await this.prisma.cliente.findUnique({
      where: { id },
      include: {
        intereses: { orderBy: { createdAt: 'desc' } },
        leads: { orderBy: { createdAt: 'desc' } },
        ventas: { orderBy: { createdAt: 'desc' } },
      },
    });

    if (!cliente || (soloAgenteId && cliente.agenteId && cliente.agenteId !== soloAgenteId)) {
      throw new NotFoundException(`Cliente ${id} no encontrado`);
    }
    return cliente;
  }

  async findByTelefono(telefono: string) {
    return this.prisma.cliente.findUnique({ where: { telefono } });
  }

  /**
   * Get-or-create por teléfono, a prueba de concurrencia — para el webhook
   * de WhatsApp.
   *
   * A diferencia de `create()` (que lanza 409 si el teléfono ya existe, lo
   * correcto para el alta manual desde el CRM), aquí dos mensajes entrantes
   * simultáneos de un número nuevo NO deben pelearse: sin esto, el segundo
   * `create` reventaba contra el índice único de `telefono` con un 500 y Meta
   * reintentaba el webhook.
   *
   * OJO: `prisma.upsert` NO basta — internamente hace "buscar → insertar", así
   * que bajo carrera real uno de los dos inserts choca igual contra el único
   * (probado). El patrón correcto es intentar crear y, si el índice único
   * rebota (P2002), releer: para entonces la otra petición ya lo creó.
   */
  async obtenerOCrearPorTelefono(nombre: string, telefono: string) {
    const existente = await this.findByTelefono(telefono);
    if (existente) {
      return existente;
    }
    try {
      return await this.prisma.cliente.create({ data: { nombre, telefono } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const yaCreado = await this.findByTelefono(telefono);
        if (yaCreado) {
          return yaCreado; // otra petición concurrente lo creó en el ínterin
        }
      }
      throw error;
    }
  }

  /** `soloAgenteId` — ver la nota de `findOne`: mismo hueco existía en edición. */
  async update(id: string, dto: UpdateClienteDto, usuarioId?: string, soloAgenteId?: string) {
    await this.findOne(id, soloAgenteId);
    const actualizado = await this.prisma.cliente.update({
      where: { id },
      data: {
        ...dto,
        datosExtra: dto.datosExtra as Prisma.InputJsonValue | undefined,
      },
    });

    if (dto.agenteId !== undefined) {
      await this.prisma.lead.updateMany({
        where: { clienteId: id },
        data: { agenteId: dto.agenteId },
      });
      await this.prisma.conversacion.updateMany({
        where: { clienteId: id },
        data: { agenteId: dto.agenteId },
      });
    }

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
