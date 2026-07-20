import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { ClientesService } from '../clientes/clientes.service';
import { CreateLeadPresencialDto } from './dto/create-lead-presencial.dto';
import { QueryLeadDto } from './dto/query-lead.dto';

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

  /** Visibilidad por rol: AGENTE ve sus leads + los sin asignar; ADMIN todo. */
  async findAll(query: QueryLeadDto, soloAgenteId?: string) {
    return this.prisma.lead.findMany({
      where: {
        origen: query.origen,
        agenteId: query.agenteId,
        ...(soloAgenteId ? { OR: [{ agenteId: soloAgenteId }, { agenteId: null }] } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: {
        cliente: { select: { id: true, nombre: true, telefono: true, categoria: true } },
        agente: { select: { id: true, nombre: true } },
      },
      take: 200,
    });
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
}
