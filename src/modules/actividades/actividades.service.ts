import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { EstadoActividad, Prisma } from '@prisma/client';

import { alcanceAgente, cubreRol } from '../../common/auth/roles';
import { UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { calcularPaginacion, paginar } from '../../common/dto/pagination.dto';
import { PushService } from '../../common/push/push.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientesService } from '../clientes/clientes.service';
import { CreateActividadDto } from './dto/create-actividad.dto';
import { QueryActividadDto } from './dto/query-actividad.dto';
import { UpdateActividadDto } from './dto/update-actividad.dto';

/** Campos que viajan en listado y ficha — declarados una vez para que no diverjan. */
const INCLUYE_ACTIVIDAD = {
  cliente: { select: { id: true, nombre: true, telefono: true } },
  lead: { select: { id: true, estado: true, origen: true } },
  agente: { select: { id: true, nombre: true } },
} satisfies Prisma.ActividadInclude;

const VENTANA_RECORDATORIO_MIN = 15;
const INTERVALO_BARRIDO_MS = 5 * 60 * 1000;

/**
 * Seguimiento comercial: recordatorios y tareas que un agente se agenda sobre
 * un Cliente/Lead. NO es la agenda médica (horario clínico de los médicos,
 * app y base independientes) — acá no se reserva ningún recurso físico, así
 * que no hay regla de "no dos citas encimadas".
 *
 * El barrido de recordatorios (`onModuleInit`) sigue el mismo patrón que
 * `TipoCambioService`: un `setInterval` que sobrevive a un `systemctl restart`
 * a cualquier hora, en vez de un cron a hora fija que se puede saltar un
 * reinicio, con `.unref()` para no ser el motivo por el que el proceso sigue
 * vivo.
 */
@Injectable()
export class ActividadesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ActividadesService.name);
  private intervalo?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly clientesService: ClientesService,
    private readonly pushService: PushService,
  ) {}

  onModuleInit(): void {
    /* La suite unitaria/integración de este backend instancia los services a
       mano, no el AppModule completo — esto es solo por si algún día alguien
       bootstrapea el módulo entero en una prueba. */
    if (process.env.NODE_ENV === 'test') return;

    this.intervalo = setInterval(() => void this.barrerRecordatoriosPendientes(), INTERVALO_BARRIDO_MS);
    this.intervalo.unref();
  }

  onModuleDestroy(): void {
    if (this.intervalo) clearInterval(this.intervalo);
  }

  private construirWhere(query: QueryActividadDto, soloAgenteId?: string): Prisma.ActividadWhereInput {
    const busqueda = query.q?.trim();

    return {
      tipo: query.tipo,
      estado: query.estado,
      clienteId: query.clienteId,
      leadId: query.leadId,
      // Un AGENTE siempre queda acotado a lo suyo — no existe un "pool sin
      // asignar" para tareas personales, a diferencia de Leads/Conversaciones.
      agenteId: soloAgenteId ?? query.agenteId,
      fechaProgramada: {
        gte: query.desde,
        lte: query.hasta,
      },
      ...(busqueda
        ? {
            OR: [
              { titulo: { contains: busqueda, mode: 'insensitive' } },
              { notas: { contains: busqueda, mode: 'insensitive' } },
              { cliente: { nombre: { contains: busqueda, mode: 'insensitive' } } },
            ] satisfies Prisma.ActividadWhereInput[],
          }
        : {}),
    };
  }

  async findAll(query: QueryActividadDto, soloAgenteId?: string) {
    const where = this.construirWhere(query, soloAgenteId);
    const { skip, take } = calcularPaginacion(query);

    const [datos, total] = await this.prisma.$transaction([
      this.prisma.actividad.findMany({
        where,
        orderBy: { fechaProgramada: 'asc' },
        include: INCLUYE_ACTIVIDAD,
        skip,
        take,
      }),
      this.prisma.actividad.count({ where }),
    ]);

    return paginar(datos, total, query);
  }

  /**
   * Conteos para las cabeceras de "Hoy" / "Vencidas" / "Próximos 7 días" —
   * mismo criterio que `LeadsService.resumenPorEstado`: la UI necesita el
   * total real, no solo cuántas tarjetas cargó.
   */
  async resumen(query: QueryActividadDto, soloAgenteId?: string) {
    const where = this.construirWhere(query, soloAgenteId);
    const ahora = new Date();
    const inicioHoy = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
    const finHoy = new Date(inicioHoy.getTime() + 24 * 60 * 60 * 1000);
    const en7Dias = new Date(inicioHoy.getTime() + 7 * 24 * 60 * 60 * 1000);
    const pendiente = { ...where, estado: 'PENDIENTE' as const };

    const [vencidas, hoy, proximaSemana] = await this.prisma.$transaction([
      this.prisma.actividad.count({ where: { ...pendiente, fechaProgramada: { lt: inicioHoy } } }),
      this.prisma.actividad.count({
        where: { ...pendiente, fechaProgramada: { gte: inicioHoy, lt: finHoy } },
      }),
      this.prisma.actividad.count({
        where: { ...pendiente, fechaProgramada: { gte: finHoy, lt: en7Dias } },
      }),
    ]);

    return { vencidas, hoy, proximaSemana };
  }

  async findOne(id: string, soloAgenteId?: string) {
    const actividad = await this.prisma.actividad.findUnique({
      where: { id },
      include: INCLUYE_ACTIVIDAD,
    });
    if (!actividad || !this.enAlcance(actividad, soloAgenteId)) {
      throw new NotFoundException(`Actividad ${id} no encontrada`);
    }
    return actividad;
  }

  /**
   * `usuario` completo (no solo el id) porque decide dos cosas: quién queda
   * como dueño (`agenteId`, salvo que un ADMIN+ agende a nombre de otro
   * agente) y el alcance para validar que el cliente/lead citados son
   * visibles para quien crea la actividad.
   */
  async create(dto: CreateActividadDto, usuario: UsuarioJwt) {
    const soloAgenteId = alcanceAgente(usuario);
    // Reusa la validación de existencia + escopado por rol de Clientes: si el
    // cliente no existe o está fuera del alcance de quien la crea, esto ya
    // lanza NotFoundException — no hace falta repetir el chequeo aquí.
    await this.clientesService.findOne(dto.clienteId, soloAgenteId);

    if (dto.leadId) {
      const lead = await this.prisma.lead.findUnique({
        where: { id: dto.leadId },
        select: { id: true, clienteId: true },
      });
      if (!lead || lead.clienteId !== dto.clienteId) {
        throw new NotFoundException(`Lead ${dto.leadId} no encontrado para este cliente`);
      }
    }

    // Solo ADMIN+ puede agendarle una tarea a otra persona; un agente normal
    // siempre queda como dueño de lo que crea, sin importar qué mande el body.
    const agenteId =
      dto.agenteId && cubreRol(usuario.rol, 'ADMIN') ? dto.agenteId : usuario.sub;
    if (agenteId !== usuario.sub) {
      const agente = await this.prisma.usuario.findUnique({ where: { id: agenteId } });
      if (!agente || !agente.activo) {
        throw new NotFoundException(`Agente ${agenteId} no encontrado o inactivo`);
      }
    }

    return this.prisma.actividad.create({
      data: {
        tipo: dto.tipo,
        titulo: dto.titulo.trim(),
        notas: dto.notas?.trim(),
        fechaProgramada: dto.fechaProgramada,
        clienteId: dto.clienteId,
        leadId: dto.leadId,
        agenteId,
      },
      include: INCLUYE_ACTIVIDAD,
    });
  }

  async update(id: string, dto: UpdateActividadDto, soloAgenteId?: string) {
    const existente = await this.prisma.actividad.findUnique({
      where: { id },
      select: { id: true, agenteId: true, clienteId: true },
    });
    if (!existente || !this.enAlcance(existente, soloAgenteId)) {
      throw new NotFoundException(`Actividad ${id} no encontrada`);
    }

    if (dto.leadId) {
      const clienteId = dto.clienteId ?? existente.clienteId;
      const lead = await this.prisma.lead.findUnique({
        where: { id: dto.leadId },
        select: { id: true, clienteId: true },
      });
      if (!lead || lead.clienteId !== clienteId) {
        throw new NotFoundException(`Lead ${dto.leadId} no encontrado para este cliente`);
      }
    }

    return this.prisma.actividad.update({
      where: { id },
      data: {
        tipo: dto.tipo,
        titulo: dto.titulo?.trim(),
        notas: dto.notas?.trim(),
        fechaProgramada: dto.fechaProgramada,
        clienteId: dto.clienteId,
        leadId: dto.leadId,
        // Reprogramar limpia el aviso ya mandado: si la nueva fecha vuelve a
        // caer dentro de la ventana, el barrido debe poder notificar de nuevo.
        ...(dto.fechaProgramada ? { notificadaEn: null } : {}),
      },
      include: INCLUYE_ACTIVIDAD,
    });
  }

  async actualizarEstado(id: string, estado: EstadoActividad, soloAgenteId?: string) {
    const existente = await this.prisma.actividad.findUnique({
      where: { id },
      select: { id: true, agenteId: true },
    });
    if (!existente || !this.enAlcance(existente, soloAgenteId)) {
      throw new NotFoundException(`Actividad ${id} no encontrada`);
    }

    return this.prisma.actividad.update({
      where: { id },
      data: {
        estado,
        completadaEn: estado === 'COMPLETADA' ? new Date() : null,
      },
      include: INCLUYE_ACTIVIDAD,
    });
  }

  async remove(id: string, soloAgenteId?: string): Promise<{ ok: true }> {
    const existente = await this.prisma.actividad.findUnique({
      where: { id },
      select: { id: true, agenteId: true },
    });
    if (!existente || !this.enAlcance(existente, soloAgenteId)) {
      throw new NotFoundException(`Actividad ${id} no encontrada`);
    }
    await this.prisma.actividad.delete({ where: { id } });
    return { ok: true };
  }

  private enAlcance(actividad: { agenteId: string }, soloAgenteId?: string): boolean {
    return !soloAgenteId || actividad.agenteId === soloAgenteId;
  }

  /**
   * Recordatorios PENDIENTES cuya hora cae dentro de los próximos
   * `VENTANA_RECORDATORIO_MIN` minutos y que todavía no se notificaron.
   * Expuesto (no `private`) para que la prueba pueda esperar su promesa —
   * el `onModuleInit` la dispara con `void`, igual que `TipoCambioService`.
   */
  async barrerRecordatoriosPendientes(): Promise<number> {
    const ahora = new Date();
    const limite = new Date(ahora.getTime() + VENTANA_RECORDATORIO_MIN * 60 * 1000);

    const pendientes = await this.prisma.actividad.findMany({
      where: {
        estado: 'PENDIENTE',
        notificadaEn: null,
        fechaProgramada: { lte: limite },
      },
      select: { id: true, titulo: true, tipo: true, agenteId: true, cliente: { select: { nombre: true } } },
    });

    for (const actividad of pendientes) {
      try {
        await this.pushService.enviarAUsuario(actividad.agenteId, {
          titulo: 'Recordatorio',
          mensaje: `${actividad.titulo} — ${actividad.cliente.nombre}`,
          url: '/actividades',
          tag: `actividad-${actividad.id}`,
        });
        await this.prisma.actividad.update({
          where: { id: actividad.id },
          data: { notificadaEn: ahora },
        });
      } catch (error: unknown) {
        // Nunca debe tumbar el barrido completo: una falla notificando una
        // actividad no puede perder el aviso de las demás. Mismo criterio que
        // el try/catch por elemento de `procesarWebhook` (crm-backend-module).
        this.logger.warn(`No se pudo notificar la actividad ${actividad.id}`, error);
      }
    }

    return pendientes.length;
  }
}
