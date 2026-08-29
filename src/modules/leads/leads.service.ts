import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EstadoLead, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { ClientesService } from '../clientes/clientes.service';
import { CreateLeadPresencialDto } from './dto/create-lead-presencial.dto';
import { QueryLeadDto } from './dto/query-lead.dto';
import { calcularPaginacion, paginar } from '../../common/dto/pagination.dto';

/** Lo mínimo para resolver el agente que se muestra en una tarjeta de lead. */
interface LeadConAgente {
  agente?: { id: string; nombre: string } | null;
  cliente?: {
    agente?: { id: string; nombre: string } | null;
    conversaciones?: Array<{ agente?: { id: string; nombre: string } | null }>;
  } | null;
}

/**
 * Quién sale como responsable de un lead, en tres escalones.
 *
 * El lead propio manda; si no tiene, la dueña de la paciente; y si tampoco,
 * quien lleva su conversación de WhatsApp.
 *
 * El tercer escalón faltaba y era el que importaba: `enviarMensaje` reclama la
 * CONVERSACIÓN para quien contesta, pero durante meses no tocó `Cliente`, así
 * que la cadena se cortaba en el segundo escalón. En producción eso dejaba 150
 * leads sin agente visible mientras la agente estaba conversando con la
 * paciente — el tablero decía "sin asignar" de gente perfectamente atendida.
 *
 * Es un respaldo de LECTURA: no escribe. Quién es la dueña de verdad se decide
 * al contestar (`reclamarSiNoTieneDuena`) o al reasignar a mano.
 */
function agenteEfectivo(lead: LeadConAgente) {
  return lead.agente ?? lead.cliente?.agente ?? lead.cliente?.conversaciones?.[0]?.agente ?? null;
}

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
    const busqueda = query.q?.trim();

    const condiciones: Prisma.LeadWhereInput[] = [];

    if (busqueda) {
      condiciones.push({
        OR: [
          { cliente: { nombre: { contains: busqueda, mode: 'insensitive' } } },
          { cliente: { telefono: { contains: busqueda } } },
          { campana: { contains: busqueda, mode: 'insensitive' } },
          { notas: { contains: busqueda, mode: 'insensitive' } },
        ],
      });
    }

    if (soloAgenteId) {
      condiciones.push({
        OR: [
          { agenteId: soloAgenteId },
          { agenteId: null },
          { cliente: { agenteId: soloAgenteId } },
        ],
      });
    }

    return {
      origen: query.origen ?? (excluirHistorico ? { not: 'IMPORTACION' } : undefined),
      estado: query.estado,
      agenteId: query.agenteId,
      clienteId: query.clienteId,
      ...(condiciones.length > 0 ? { AND: condiciones } : {}),
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
          cliente: {
            select: {
              id: true,
              nombre: true,
              telefono: true,
              categoria: true,
              agente: { select: { id: true, nombre: true } },
              /* Tercer escalón del respaldo — ver `agenteEfectivo`. */
              conversaciones: {
                select: { agente: { select: { id: true, nombre: true } } },
                take: 1,
                orderBy: { updatedAt: 'desc' },
              },
            },
          },
          agente: { select: { id: true, nombre: true } },
        },
        skip,
        take,
      }),
      this.prisma.lead.count({ where }),
    ]);

    const datosMapeados = datos.map(lead => ({ ...lead, agente: agenteEfectivo(lead) }));

    return paginar(datosMapeados, total, query);
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
   * Conversión automática (RF-17): al cerrarse una venta, se marca CONVERTIDO
   * el lead que la originó. Invocado por VentasService.
   *
   * Con `leadId` (la venta cita su lead de origen): cierra SOLO ese lead. Sin
   * `leadId` (venta sin lead asociado — presencial, histórica, o registrada
   * antes de que existiera este vínculo): repite el comportamiento anterior y
   * cierra TODOS los leads abiertos del cliente, que era la única señal
   * disponible antes de poder citar un lead concreto.
   *
   * La distinción importa: un cliente puede tener dos leads abiertos de dos
   * campañas distintas, y cerrar los dos como "convertidos" porque solo uno
   * terminó en venta le atribuye a la campaña equivocada el mismo resultado.
   */
  async marcarConvertidos(clienteId: string, leadId?: string | null): Promise<void> {
    if (leadId) {
      await this.prisma.lead.updateMany({
        where: { id: leadId, clienteId, estado: { in: ['NUEVO', 'CONTACTADO'] } },
        data: { estado: 'CONVERTIDO' },
      });
      return;
    }

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

    const agenteFinal = agenteId || cliente.agenteId || undefined;
    const lead = await this.prisma.lead.create({
      data: { clienteId: cliente.id, origen: 'PRESENCIAL', agenteId: agenteFinal },
      include: {
        cliente: {
          select: {
            id: true,
            nombre: true,
            telefono: true,
            categoria: true,
            agente: { select: { id: true, nombre: true } },
          },
        },
        agente: { select: { id: true, nombre: true } },
      },
    });

    return {
      ...lead,
      agente: agenteEfectivo(lead),
    };
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
    /** `ad_id` que devolvió Graph API, si lo hubo — ver `Lead.anuncioId`. */
    anuncioId?: string;
  }) {
    const existente = await this.prisma.lead.findUnique({
      where: { metaLeadId: datos.metaLeadId },
      include: {
        cliente: {
          select: {
            id: true,
            nombre: true,
            telefono: true,
            categoria: true,
            agente: { select: { id: true, nombre: true } },
          },
        },
        agente: { select: { id: true, nombre: true } },
      },
    });
    if (existente) {
      return {
        ...existente,
        agente: agenteEfectivo(existente),
      };
    }

    let cliente = await this.clientesService.findByTelefono(datos.telefono);
    if (!cliente) {
      cliente = await this.clientesService.create({
        nombre: datos.nombre,
        telefono: datos.telefono,
      });
    }

    const nuevoLead = await this.prisma.lead.create({
      data: {
        clienteId: cliente.id,
        origen: datos.origen,
        metaLeadId: datos.metaLeadId,
        anuncioId: datos.anuncioId,
        agenteId: cliente.agenteId,
      },
      include: {
        cliente: {
          select: {
            id: true,
            nombre: true,
            telefono: true,
            categoria: true,
            agente: { select: { id: true, nombre: true } },
          },
        },
        agente: { select: { id: true, nombre: true } },
      },
    });

    return {
      ...nuevoLead,
      agente: agenteEfectivo(nuevoLead),
    };
  }

  /**
   * `soloAgenteId` repite exactamente el criterio de `construirWhere`: sin este
   * chequeo, escopar `findAll` era cosmético — cualquier agente autenticado
   * podía cambiar el estado de un lead ajeno con solo conocer el UUID. 404
   * (no 403) para no confirmar que el registro existe, mismo criterio que
   * `ClientesService.findOne`.
   */
  async updateEstado(id: string, estado: EstadoLead, soloAgenteId?: string, motivoPerdida?: string) {
    const existe = await this.prisma.lead.findUnique({
      where: { id },
      select: { id: true, agenteId: true, cliente: { select: { agenteId: true } } },
    });
    if (!existe || !this.enAlcance(existe, soloAgenteId)) {
      throw new NotFoundException(`Lead ${id} no encontrado`);
    }

    /* Perder un lead sin decir por qué es irrecuperable a los tres meses —
       mismo criterio que `VentaImportada.motivoExclusion` en la planilla. */
    if (estado === 'PERDIDO' && !motivoPerdida?.trim()) {
      throw new BadRequestException('Para marcar un lead como perdido hay que indicar el motivo.');
    }

    const lead = await this.prisma.lead.update({
      where: { id },
      data: {
        estado,
        /* Al moverse a cualquier otro estado, el motivo deja de aplicar —
           dejarlo puesto haría que un lead vuelto a NUEVO siguiera mostrando
           "perdido por X". */
        motivoPerdida: estado === 'PERDIDO' ? motivoPerdida!.trim() : null,
      },
      include: {
        cliente: {
          select: {
            id: true,
            nombre: true,
            telefono: true,
            categoria: true,
            agente: { select: { id: true, nombre: true } },
          },
        },
        agente: { select: { id: true, nombre: true } },
      },
    });

    return {
      ...lead,
      agente: agenteEfectivo(lead),
    };
  }

  /**
   * Reasignar el agente responsable de un lead — el controller ya exige
   * `@Roles('ADMIN')`, igual que el mismo gesto en Conversaciones.
   *
   * Delega la cascada a `ClientesService.update()` en vez de escribir
   * `prisma.cliente`/`prisma.conversacion` aquí: esa es la copia correcta
   * (transacción + AuditLog) y esta ya había divergido de ella — no tocaba
   * los OTROS leads abiertos del mismo cliente (solo este `id`) y no dejaba
   * rastro en auditoría. Escribir la tabla de otro dominio directamente
   * también rompe el aislamiento de persistencia (CRM_MANIFESTO.md §1.1).
   */
  async asignarAgente(id: string, agenteId: string | null, usuarioId?: string) {
    const existe = await this.prisma.lead.findUnique({
      where: { id },
      select: { id: true, clienteId: true },
    });
    if (!existe) {
      throw new NotFoundException(`Lead ${id} no encontrado`);
    }

    if (agenteId) {
      const agente = await this.prisma.usuario.findUnique({ where: { id: agenteId } });
      if (!agente || !agente.activo) {
        throw new NotFoundException(`Agente ${agenteId} no encontrado o inactivo`);
      }
    }

    await this.clientesService.update(existe.clienteId, { agenteId }, usuarioId);

    const lead = await this.prisma.lead.findUniqueOrThrow({
      where: { id },
      include: {
        cliente: {
          select: {
            id: true,
            nombre: true,
            telefono: true,
            categoria: true,
            agente: { select: { id: true, nombre: true } },
          },
        },
        agente: { select: { id: true, nombre: true } },
      },
    });

    return {
      ...lead,
      agente: agenteEfectivo(lead),
    };
  }

  /** Mismo criterio de visibilidad que `construirWhere`: propio, sin asignar, o del cliente propio. */
  private enAlcance(
    lead: { agenteId: string | null; cliente?: { agenteId: string | null } | null },
    soloAgenteId?: string,
  ): boolean {
    return (
      !soloAgenteId ||
      lead.agenteId === soloAgenteId ||
      lead.agenteId === null ||
      lead.cliente?.agenteId === soloAgenteId
    );
  }
}
