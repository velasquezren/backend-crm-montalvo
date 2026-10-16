import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RowDataPacket } from 'mysql2/promise';
import { Subject } from 'rxjs';
import { Prisma } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import { DirectorioService } from '../directorio/directorio.service';
import { AgendaAdminClient } from './agenda-admin.client';
import { fichaMedicoAgenda, guardarHorarioAgenda } from './agenda-admin.sql';
import { AgendaService } from './agenda.service';
import { HorarioFilemakerDto } from './dto/horario-filemaker.dto';
import { prepararHorarioFilemaker } from './horario-filemaker';

/**
 * FileMaker conserva su envío hasta recibir SINCRONIZADO. PostgreSQL conserva
 * primero la última revisión aceptada; MySQL y la ficha web se aplican después.
 * No hay transacción distribuida: un fallo deja pendiente esa MISMA instantánea,
 * que se reaplica de forma idempotente. Nunca retrocede a una revisión anterior.
 */
@Injectable()
export class HorarioFilemakerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HorarioFilemakerService.name);
  private reloj?: ReturnType<typeof setInterval>;
  private barrido?: Promise<void>;
  private readonly avisos = new Subject<number>();
  readonly cambios = this.avisos.asObservable();

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly agenda: AgendaAdminClient,
    private readonly directorio: DirectorioService,
    private readonly consultas: AgendaService,
  ) {}

  activo(): boolean { return this.config.get<string>('FILEMAKER_HORARIOS_ACTIVO') === 'on'; }

  exigirEdicionCrm(): void {
    if (this.activo()) throw new ForbiddenException({ codigo: 'HORARIO_EN_FILEMAKER', message: 'Los horarios se modifican en FileMaker.' });
  }

  async detalle(medicoAgendaId: number) {
    if (!this.activo()) return { origen: 'CRM' as const, pendiente: false, sincronizadoEn: null };
    const fila = await this.prisma.horarioFilemaker.findUnique({ where: { medicoAgendaId }, select: { pendiente: true, sincronizadoEn: true } });
    return { origen: 'FILEMAKER' as const, pendiente: fila?.pendiente ?? true, sincronizadoEn: fila?.sincronizadoEn ?? null };
  }

  private async candado(tx: Prisma.TransactionClient, codigo: string): Promise<void> {
    await tx.$executeRaw`SET LOCAL lock_timeout = '4s'`;
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(8157, hashtext(${codigo}))::text`;
  }

  async recibir(dto: HorarioFilemakerDto) {
    if (!this.activo()) throw new ServiceUnavailableException('La integración de horarios está deshabilitada.');
    const preparado = prepararHorarioFilemaker(dto);
    const { datos, huella } = preparado;
    const ids = await this.agenda.consultar(async db => {
      const [filas] = await db.execute<RowDataPacket[]>('SELECT medico_pk FROM medicos WHERE UPPER(TRIM(codigo)) = ? LIMIT 2', [datos.medicoCodigo]);
      return filas.map(f => Number(f.medico_pk));
    });
    if (!ids.length) throw new NotFoundException('El código de FileMaker no corresponde a ningún médico de la agenda.');
    if (ids.length !== 1) throw new ConflictException('Hay más de un médico con ese código. Debe corregirse antes de sincronizar.');
    try {
      await this.prisma.$transaction(async tx => {
        await this.candado(tx, datos.medicoCodigo);
        const anterior = await tx.horarioFilemaker.findUnique({ where: { codigo: datos.medicoCodigo } });
        if (anterior) {
          if (anterior.registroId !== datos.registroId || anterior.medicoAgendaId !== ids[0]) throw new ConflictException('Este médico ya está vinculado a otro registro de horarios. No se combinaron registros ni sucursales.');
          if (datos.revision < anterior.revision) throw new ConflictException('Llegó una revisión antigua. El horario más reciente se conserva.');
          if (datos.revision === anterior.revision) {
            if (huella !== anterior.huella) throw new ConflictException('La misma revisión contiene horarios diferentes. Guarde una nueva revisión en FileMaker.');
            return;
          }
        }
        const campos = { registroId: datos.registroId, medicoAgendaId: ids[0], revision: datos.revision, huella, datos: JSON.parse(JSON.stringify(datos)) as Prisma.InputJsonValue, pendiente: true };
        await tx.horarioFilemaker.upsert({ where: { codigo: datos.medicoCodigo }, create: { codigo: datos.medicoCodigo, ...campos }, update: campos });
        await tx.auditLog.create({ data: { entidad: 'HorarioFilemaker', entidadId: datos.medicoCodigo, accion: 'HORARIO_FILEMAKER_RECIBIDO', cambios: { registroId: datos.registroId, revision: datos.revision, medicoAgendaId: ids[0], cupos: preparado.activas.length, minutosConsulta: preparado.minutosConsulta } } });
      });
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('Este registro o médico ya tiene otra vinculación de horario.');
      throw error;
    }
    this.avisos.next(ids[0]);
    return this.aplicar(datos.medicoCodigo, datos.revision);
  }

  async aplicar(codigo: string, revisionSolicitada?: number) {
    const respuesta = await this.prisma.$transaction(async tx => {
      await this.candado(tx, codigo);
      const fila = await tx.horarioFilemaker.findUnique({ where: { codigo } });
      if (!fila) throw new NotFoundException('No hay horario recibido para ese médico.');
      if (revisionSolicitada !== undefined && fila.revision !== revisionSolicitada) throw new ConflictException('Ya se recibió una revisión más reciente.');
      const preparado = prepararHorarioFilemaker(fila.datos as unknown as HorarioFilemakerDto);
      let sincronizadoEn = fila.sincronizadoEn;
      if (fila.pendiente) {
        const resultado = await this.agenda.enTransaccion(async db => {
          const ficha = await fichaMedicoAgenda(db, fila.medicoAgendaId);
          if (!ficha || ficha.medico.codigo?.trim().toUpperCase() !== codigo) return null;
          const guardado = await guardarHorarioAgenda(db, fila.medicoAgendaId, ficha.version, preparado.activas, preparado.html, preparado.minutosConsulta);
          return guardado.ok ? ficha.medico : null;
        });
        if (!resultado) throw new ConflictException('El médico o su código cambió en la agenda. Debe revisarse la vinculación.');
        this.consultas.invalidarCatalogo();
        const precio = Number(resultado.precio);
        await this.directorio.sincronizarConAgenda(fila.medicoAgendaId, {
          precioConsulta: Number.isFinite(precio) && precio > 0 ? precio : null,
          orden: resultado.orden, bloques: preparado.bloques,
        });
        sincronizadoEn = new Date();
        await tx.horarioFilemaker.update({ where: { codigo }, data: { pendiente: false, sincronizadoEn } });
        await tx.auditLog.create({ data: { entidad: 'HorarioFilemaker', entidadId: codigo, accion: 'HORARIO_FILEMAKER_SINCRONIZADO', cambios: { revision: fila.revision, medicoAgendaId: fila.medicoAgendaId, cupos: preparado.activas.length, minutosConsulta: preparado.minutosConsulta } } });
      }
      return { estado: 'SINCRONIZADO' as const, registroId: fila.registroId, medicoCodigo: codigo, revision: fila.revision, medicoAgendaId: fila.medicoAgendaId, cupos: preparado.activas.length, minutosConsulta: preparado.minutosConsulta, sincronizadoEn };
    }, { timeout: 25_000, maxWait: 5_000 });
    this.avisos.next(respuesta.medicoAgendaId);
    return respuesta;
  }

  /** Diez médicos por minuto, en serie. Un error no impide procesar el siguiente. */
  async reintentarPendientes(): Promise<void> {
    if (!this.activo()) return;
    const pendientes = await this.prisma.horarioFilemaker.findMany({ where: { pendiente: true }, orderBy: { updatedAt: 'asc' }, take: 10, select: { codigo: true } });
    for (const { codigo } of pendientes) {
      try { await this.aplicar(codigo); }
      catch {
        // Rota el fallo al final para no bloquear siempre a los mismos diez.
        await this.prisma.horarioFilemaker.updateMany({ where: { codigo, pendiente: true }, data: { updatedAt: new Date() } });
        this.logger.warn('Un horario recibido de FileMaker sigue pendiente; se reintentará.');
      }
    }
  }

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || !this.activo()) return;
    this.reloj = setInterval(() => {
      if (this.barrido) return;
      this.barrido = this.reintentarPendientes().catch(() => { this.logger.warn('No se pudo consultar los horarios pendientes.'); }).finally(() => { this.barrido = undefined; });
    }, 60_000);
    this.reloj.unref();
  }

  async onModuleDestroy(): Promise<void> { if (this.reloj) clearInterval(this.reloj); await this.barrido; }
}
