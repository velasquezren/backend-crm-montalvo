import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { puedeVerAgendaClinica } from '../../common/auth/roles';
import { fechaCivilClinica, textoDeFechaCivil } from '../../common/fechas/zona-clinica';
import { enSegundoPlano } from '../../common/fiabilidad/en-segundo-plano';
import { PushService } from '../../common/push/push.service';
import { PrismaService } from '../../prisma/prisma.service';
import { EstadoActividad, Rol } from '../../prisma/prisma-client';
import { AgendaConsultaClient } from '../agenda/agenda-consulta.client';
import { FilaReservaAgenda, reservasParaSeguimiento, reservasPorIds } from '../agenda/agenda-consulta.sql';
import { ComprobantesReservaChatService } from '../conversaciones/comprobantes-reserva-chat.service';
import { ConversacionesGateway } from '../conversaciones/conversaciones.gateway';
import { LineasWhatsappService } from '../lineas-whatsapp/lineas-whatsapp.service';

const LOTE = 50;
const LOTE_AVISOS = 10;
const INTERVALO = 30_000;
const LEASE = 120_000;
const ROLES_AGENDA = Object.values(Rol).filter(puedeVerAgendaClinica);
const limpio = (texto: string, max: number) => texto.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

/** Una tarea de gestión por reserva, nunca una segunda agenda. El cursor
 * descubre por PK; las conocidas se revisitan por antigüedad de consulta.
 * Fallar una lectura conserva el estado anterior. Ninguna escritura va a MySQL. */
@Injectable()
export class ReservasActividadesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReservasActividadesService.name);
  private intervalo?: NodeJS.Timeout;
  private corriendo = false;
  private cursor = 0;

  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService,
    private readonly agenda: AgendaConsultaClient, private readonly comprobantes: ComprobantesReservaChatService,
    private readonly lineas: LineasWhatsappService, private readonly gateway: ConversacionesGateway,
    private readonly push: PushService) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.intervalo = setInterval(() => void enSegundoPlano('seguimiento de reservas', this.logger, () => this.sincronizar()), INTERVALO);
    this.intervalo.unref();
  }
  onModuleDestroy(): void { clearInterval(this.intervalo); }
  private habilitada(): boolean { return this.config.get<string>('RESERVAS_ACTIVIDADES') === 'on' && this.agenda.habilitada(); }

  async sincronizar(ahora = new Date()): Promise<number> {
    if (this.corriendo || !this.habilitada()) return 0;
    this.corriendo = true;
    try {
      const conocidas = await this.prisma.actividad.findMany({
        where: { reservaAgenda: { not: null }, OR: [{ estado: 'PENDIENTE' }, { reservaFecha: { gte: new Date(ahora.getTime() - 7 * 86_400_000) } }],
          reservaRevisadaEn: { lte: new Date(ahora.getTime() - INTERVALO) } },
        orderBy: [{ reservaRevisadaEn: 'asc' }, { id: 'asc' }], take: LOTE,
        select: { reservaAgenda: true },
      });
      const ids = conocidas.flatMap(a => a.reservaAgenda === null ? [] : [a.reservaAgenda]);
      const actuales = await this.agenda.ejecutar(db => reservasPorIds(db, ids));
      for (const id of ids) await this.proyectar(actuales.find(r => r.id === id) ?? null, id, ahora);
      const nuevas = await this.agenda.ejecutar(db => reservasParaSeguimiento(db, textoDeFechaCivil(fechaCivilClinica(ahora)), this.cursor, LOTE));
      for (const reserva of nuevas) await this.proyectar(reserva, reserva.id, ahora);
      this.cursor = nuevas.length === LOTE ? nuevas[nuevas.length - 1]!.id : 0;
      await this.notificarPendientes(ahora);
      return ids.length + nuevas.length;
    } finally { this.corriendo = false; }
  }

  private async proyectar(r: FilaReservaAgenda | null, id: number, ahora: Date): Promise<void> {
    const reservaEstado = r?.estado || 'NO_ENCONTRADA';
    const estado: EstadoActividad = reservaEstado === 'ATENDIDO' ? 'COMPLETADA'
      : reservaEstado === 'NO_ENCONTRADA' ? 'CANCELADA' : 'PENDIENTE';
    const titulo = reservaEstado === 'PAGADO' ? `Verificar comprobante de reserva #${id}`
      : reservaEstado === 'ATENDIDO' ? `Reserva #${id} gestionada`
      : reservaEstado === 'NO_ENCONTRADA' ? `Reserva #${id} retirada de la agenda`
      : `Gestionar reserva #${id}`;
    const fecha = r && new Date(`${r.fecha}T${r.hora}:00-04:00`);
    if (fecha && !Number.isFinite(fecha.getTime())) throw new Error('Fecha de reserva inválida');
    const cambio = await this.prisma.$transaction(async tx => {
      // Serializa proyecciones concurrentes de la misma reserva sin mantener
      // el candado durante una consulta remota ni un envío de notificaciones.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(8154, ${id})::text`;
      const anterior = await tx.actividad.findUnique({ where: { reservaAgenda: id } });
      if (anterior?.reservaRevisadaEn && anterior.reservaRevisadaEn > ahora) return null;
      if (!r && !anterior) return null;
      const chat = await tx.reservaChat.findUnique({ where: { reservaAgenda: id },
        select: { conversacionId: true, conversacion: { select: { clienteId: true } } } });
      const datos = {
        titulo, estado, reservaEstado,
        reservaFecha: fecha ?? anterior?.reservaFecha ?? null,
        reservaMedico: r ? limpio(r.medico, 160) : anterior?.reservaMedico,
        reservaPaciente: r ? limpio(r.paciente, 120) : anterior?.reservaPaciente,
        conversacionId: chat?.conversacionId ?? anterior?.conversacionId ?? null,
        reservaDeChat: !!chat || anterior?.reservaDeChat || false,
        clienteId: chat?.conversacion.clienteId ?? anterior?.clienteId ?? null,
      };
      const distinta = !anterior || Object.entries(datos).some(([k, v]) => {
        const previo = anterior[k as keyof typeof anterior];
        return v instanceof Date ? !(previo instanceof Date) || v.getTime() !== previo.getTime() : v !== previo;
      });
      const completadaEn = estado === 'COMPLETADA' ? anterior?.completadaEn ?? ahora : null;
      const actividad = anterior ? await tx.actividad.update({ where: { id: anterior.id }, data: {
        ...datos, completadaEn, reservaRevisadaEn: ahora,
        ...(distinta ? { notificadaEn: null, avisoEnProcesoHasta: null,
          ...(estado === 'PENDIENTE' ? { fechaProgramada: ahora } : {}) } : {}),
      } }) : await tx.actividad.create({ data: { ...datos, reservaAgenda: id, tipo: 'TAREA',
        fechaProgramada: ahora, duracionMinutos: 5, completadaEn, reservaRevisadaEn: ahora } });
      const chats = await this.comprobantes.reconciliarAgenda(id, reservaEstado, r?.tieneComprobante ?? false, tx);
      return { actividad: distinta ? actividad : null, chats };
    });
    for (const chat of cambio?.chats ?? []) this.gateway.emitirActividad(chat);
    if (cambio?.actividad) {
      const audiencia = await this.audiencia(cambio.actividad);
      await this.gateway.emitirCambioActividad(cambio.actividad.id, audiencia.ven);
    }
  }

  private async audiencia(actividad: { reservaDeChat: boolean; conversacionId: string | null }) {
    if (actividad.reservaDeChat) return actividad.conversacionId
      ? this.lineas.audiencia(actividad.conversacionId) : { ven: [], avisar: [] };
    const usuarios = await this.prisma.usuario.findMany({ where: { activo: true, rol: { in: ROLES_AGENDA } }, select: { id: true } });
    return { ven: usuarios.map(u => u.id), avisar: usuarios.map(u => u.id) };
  }

  /** La campana es durable en Actividad. Push/socket solo llaman la atención;
   * la misma etiqueta sustituye el aviso ante un reintento tras un fallo. */
  async notificarPendientes(ahora = new Date()): Promise<void> {
    if (!this.habilitada()) return;
    const pendientes = await this.prisma.actividad.findMany({ where: { reservaAgenda: { not: null }, estado: 'PENDIENTE', notificadaEn: null,
      OR: [{ avisoEnProcesoHasta: null }, { avisoEnProcesoHasta: { lte: ahora } }] },
      orderBy: [{ fechaProgramada: 'asc' }, { id: 'asc' }], take: LOTE_AVISOS });
    for (const a of pendientes) {
      const lease = new Date(ahora.getTime() + LEASE);
      const toma = await this.prisma.actividad.updateMany({ where: { id: a.id, updatedAt: a.updatedAt, estado: 'PENDIENTE', notificadaEn: null }, data: { avisoEnProcesoHasta: lease } });
      if (!toma.count) continue;
      try {
        const audiencia = await this.audiencia(a);
        if (!audiencia.ven.length) continue;
        await this.gateway.emitirCambioActividad(a.id, audiencia.ven, audiencia.avisar);
        for (const usuario of audiencia.avisar) await this.push.enviarAUsuario(usuario, {
          titulo: 'Reserva pendiente', mensaje: a.titulo, url: `/actividades?actividad=${a.id}`,
          tag: `actividad-${a.id}`, entrega: { urgente: true },
        }, { reintentar: true });
        await this.prisma.actividad.updateMany({ where: { id: a.id, avisoEnProcesoHasta: lease, estado: 'PENDIENTE' },
          data: { notificadaEn: ahora, avisoEnProcesoHasta: null } });
      } catch {
        this.logger.warn('Aviso de reserva pendiente; se reintentará al vencer la reclamación');
      }
    }
  }
}
