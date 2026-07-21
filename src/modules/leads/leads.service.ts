import { Injectable, NotFoundException } from '@nestjs/common';
import { EstadoLead, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { ClientesService } from '../clientes/clientes.service';
import { CreateLeadPresencialDto } from './dto/create-lead-presencial.dto';
import { QueryLeadDto } from './dto/query-lead.dto';
import { calcularPaginacion, paginar } from '../../common/dto/pagination.dto';

/**
 * Módulo Leads — fuentes de entrada del negocio (Meta + presencial).
 * La entidad Cliente pertenece al módulo clientes: aquí solo se consume
 * su service (CRM_MANIFESTO.md §1.1 — aislamiento de persistencia).
 */
@Injectable()
export class LeadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clientesService: ClientesService,
  ) {}

  /**
   * Construye el filtro común de leads.
   * Visibilidad por rol: AGENTE ve sus leads + los sin asignar; ADMIN todo.
   * El histórico importado se excluye salvo que se pida explícitamente.
   */
  private construirWhere(query: QueryLeadDto, soloAgenteId?: string): Prisma.LeadWhereInput {
    const excluirHistorico = !query.incluirImportacion && !query.origen;

    return {
      origen: query.origen ?? (excluirHistorico ? { not: 'IMPORTACION' } : undefined),
      estado: query.estado,
      agenteId: query.agenteId,
      ...(soloAgenteId ? { OR: [{ agenteId: soloAgenteId }, { agenteId: null }] } : {}),
    };
  }

  async findAll(query: QueryLeadDto, soloAgenteId?: string) {
    const where = this.construirWhere(query, soloAgenteId);
    const { skip, take } = calcularPaginacion(query);

    const [datos, total] = await this.prisma.$transaction([
      this.prisma.lead.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: {
          cliente: { select: { id: true, nombre: true, telefono: true, categoria: true } },
          agente: { select: { id: true, nombre: true } },
        },
        skip,
        take,
      }),
      this.prisma.lead.count({ where }),
    ]);

    return paginar(datos, total, query);
  }

  /**
   * Conteo real por estado, para las cabeceras de las columnas del kanban.
   * Sin esto la UI solo puede mostrar cuántas tarjetas cargó, no cuántas hay.
   */
  async resumenPorEstado(query: QueryLeadDto, soloAgenteId?: string) {
    const where = this.construirWhere(query, soloAgenteId);

    const estados: EstadoLead[] = ['NUEVO', 'CONTACTADO', 'CONVERTIDO', 'PERDIDO'];

    /* Un count por estado + el del histórico, todos en la misma transacción.
       Con el índice Lead(estado) es tan barato como un groupBy y el tipado
       queda explícito. */
    const resultados = await this.prisma.$transaction([
      ...estados.map(estado => this.prisma.lead.count({ where: { ...where, estado } })),
      this.prisma.lead.count({ where: { origen: 'IMPORTACION' } }),
    ]);

    const conteos = {} as Record<EstadoLead, number>;
    estados.forEach((estado, i) => {
      conteos[estado] = resultados[i];
    });
    const historico = resultados[estados.length];

    return {
      porEstado: conteos,
      totalPipeline: Object.values(conteos).reduce((suma, n) => suma + n, 0),
      /* Cuántos pacientes históricos hay archivados fuera del pipeline. */
      historicoImportado: historico,
    };
  }

  /**
   * Conversión automática (RF-17): al cerrarse una venta, los leads abiertos
   * del cliente pasan a CONVERTIDO. Invocado por VentasService.
   */
  async marcarConvertidos(clienteId: string): Promise<void> {
    await this.prisma.lead.updateMany({
      where: { clienteId, estado: { in: ['NUEVO', 'CONTACTADO'] } },
      data: { estado: 'CONVERTIDO' },
    });
  }

  /** RF-07/RF-08 — registro presencial: crea o reutiliza el cliente por teléfono. */
  async createPresencial(dto: CreateLeadPresencialDto, agenteId: string) {
    let cliente = await this.clientesService.findByTelefono(dto.telefono);
    if (!cliente) {
      cliente = await this.clientesService.create({
        nombre: dto.nombre,
        telefono: dto.telefono,
        agenteId,
      });
    }

    if (dto.interes) {
      await this.clientesService.registrarInteres(cliente.id, {
        descripcion: dto.interes,
        origen: 'PRESENCIAL',
        agenteId,
      });
    }

    return this.prisma.lead.create({
      data: { clienteId: cliente.id, origen: 'PRESENCIAL', agenteId },
      include: { cliente: true },
    });
  }

  /**
   * Punto de entrada para webhooks de Meta (RF-04).
   * El payload ya viene validado/filtrado por el controller del webhook.
   */
  async procesarLeadMeta(datos: {
    nombre: string;
    telefono: string;
    origen: 'FACEBOOK_LEAD_AD' | 'INSTAGRAM_LEAD_AD';
    metaLeadId: string;
  }) {
    const existente = await this.prisma.lead.findUnique({ where: { metaLeadId: datos.metaLeadId } });
    if (existente) {
      return existente; // Meta reintenta webhooks: idempotencia por metaLeadId
    }

    let cliente = await this.clientesService.findByTelefono(datos.telefono);
    if (!cliente) {
      cliente = await this.clientesService.create({
        nombre: datos.nombre,
        telefono: datos.telefono,
      });
    }

    return this.prisma.lead.create({
      data: { clienteId: cliente.id, origen: datos.origen, metaLeadId: datos.metaLeadId },
    });
  }

  async updateEstado(id: string, estado: EstadoLead) {
    const existe = await this.prisma.lead.findUnique({ where: { id }, select: { id: true } });
    if (!existe) {
      throw new NotFoundException(`Lead ${id} no encontrado`);
    }

    return this.prisma.lead.update({
      where: { id },
      data: { estado },
      include: {
        cliente: { select: { id: true, nombre: true, telefono: true, categoria: true } },
        agente: { select: { id: true, nombre: true } },
      },
    });
  }
}
