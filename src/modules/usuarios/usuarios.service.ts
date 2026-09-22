import { esRolOperativo, tieneAlcanceGlobal } from '../../common/auth/roles';
import { Prisma, Rol } from '../../prisma/prisma-client';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';

import { PrismaService } from '../../prisma/prisma.service';
import { CreateUsuarioDto } from './dto/create-usuario.dto';
import { UpdateUsuarioDto } from './dto/update-usuario.dto';

const SIN_PASSWORD = {
  id: true,
  lineasWhatsapp: { select: { lineaId: true } },
  nombre: true,
  email: true,
  rol: true,
  activo: true,
  foto: true,
  codigo: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Módulo Usuarios/Agentes — ciclo de vida de agentes (crear, editar, desactivar).
 * El passwordHash jamás sale del service.
 */
@Injectable()
export class UsuariosService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateUsuarioDto) {
    const existente = await this.prisma.usuario.findUnique({ where: { email: dto.email } });
    if (existente) {
      throw new ConflictException(`Ya existe un usuario con el email ${dto.email}`);
    }

    await this.validarLineas(dto.lineaIds ?? [], dto.rol ?? 'AGENTE');
    return this.prisma.usuario.create({
      data: {
        nombre: dto.nombre,
        email: dto.email,
        passwordHash: await bcrypt.hash(dto.password, 10),
        rol: dto.rol,
        lineasWhatsapp: { create: (dto.lineaIds ?? []).map(lineaId => ({ lineaId })) },
        codigo: await this.normalizarCodigo(dto.codigo),
      },
      select: SIN_PASSWORD,
    });
  }

  async findAll() {
    return this.prisma.usuario.findMany({ select: SIN_PASSWORD, orderBy: { nombre: 'asc' } });
  }

  async findOne(id: string) {
    const usuario = await this.prisma.usuario.findUnique({ where: { id }, select: SIN_PASSWORD });
    if (!usuario) {
      throw new NotFoundException(`Usuario ${id} no encontrado`);
    }
    return usuario;
  }

  /** Solo para AuthService — incluye el hash para validar credenciales. */
  async findByEmailConPassword(email: string) {
    return this.prisma.usuario.findUnique({ where: { email } });
  }

  async update(id: string, dto: UpdateUsuarioDto, ejecutorId?: string) {
    const { password, lineaIds, ...resto } = dto;
    const passwordHash = password ? await bcrypt.hash(password, 10) : undefined;
    return this.prisma.$transaction(async tx => {
      // Una sola orden para todas las mutaciones de acceso; protege también al último superadmin.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(730013)::text`;
      const actual = await tx.usuario.findUnique({ where: { id }, select: SIN_PASSWORD });
      if (!actual) throw new NotFoundException(`Usuario ${id} no encontrado`);
      const permisos = lineaIds ?? actual.lineasWhatsapp.map(l => l.lineaId);
      await this.validarLineas(permisos, dto.rol ?? actual.rol, tx);
      if (ejecutorId === id && resto.rol && resto.rol !== actual.rol) {
        throw new BadRequestException('No puedes cambiarte a ti mismo el rol.');
      }
      if (ejecutorId === id && resto.activo === false) {
        throw new BadRequestException('No puedes desactivar tu propia cuenta.');
      }
      if (actual.rol === 'SUPER_ADMIN' && ((resto.rol && resto.rol !== 'SUPER_ADMIN') || resto.activo === false)) {
        await this.verificarQueQuedaOtroSuperAdmin(id, tx);
      }
      const actualizado = await tx.usuario.update({
        where: { id },
        data: {
          ...resto,
          ...(resto.codigo !== undefined ? { codigo: await this.normalizarCodigo(resto.codigo, id, tx) } : {}),
          ...(passwordHash ? { passwordHash } : {}),
          ...(password || resto.rol !== undefined || resto.activo !== undefined || lineaIds !== undefined
            ? { versionSesion: { increment: 1 } } : {}),
          ...(lineaIds !== undefined ? { lineasWhatsapp: { deleteMany: {}, create: lineaIds.map(lineaId => ({ lineaId })) } } : {}),
        }, select: SIN_PASSWORD,
      });
      if (lineaIds !== undefined || resto.rol !== undefined || resto.activo !== undefined) {
        if (!actualizado.activo || !tieneAlcanceGlobal(actualizado.rol)) {
          await tx.conversacion.updateMany({ where: { agenteId: id, ...(actualizado.activo ? { lineaId: { notIn: permisos } } : {}) }, data: { agenteId: null } });
        }
      }
      if (lineaIds !== undefined) {
        await tx.auditLog.create({ data: { entidad: 'Usuario', entidadId: id, accion: 'LINEAS_ASIGNADAS', usuarioId: ejecutorId, cambios: { lineaIds } } });
      }
      return actualizado;
    });
  }

  private async validarLineas(ids: string[], rol: Rol, db: Prisma.TransactionClient = this.prisma): Promise<void> {
    if (!ids.length) return;
    const lineas = await db.lineaWhatsapp.findMany({ where: { id: { in: ids } }, select: { id: true, comercial: true } });
    if (lineas.length !== ids.length) throw new BadRequestException('Alguna línea no existe o está repetida.');
    if (esRolOperativo(rol) && lineas.some(l => l.comercial)) {
      throw new BadRequestException('Este rol solo puede acceder a líneas de atención; la línea comercial corresponde a agentes de ventas.');
    }
  }

  /**
   * El código de empresa es único. El vacío se guarda como `null`, no como '':
   * varias cadenas vacías chocarían contra el índice único, mientras que Postgres
   * permite tantos NULL como haga falta.
   */
  private async normalizarCodigo(codigo: string | undefined, exceptoId?: string, db: Prisma.TransactionClient = this.prisma) {
    const limpio = codigo?.trim();
    if (!limpio) return null;

    const enUso = await db.usuario.findUnique({
      where: { codigo: limpio },
      select: { id: true, nombre: true },
    });
    if (enUso && enUso.id !== exceptoId) {
      throw new ConflictException(
        `El código "${limpio}" ya lo usa ${enUso.nombre}.`,
      );
    }
    return limpio;
  }

  /** Desactivación en vez de borrado — el historial de ventas/comisiones se preserva. */
  async desactivar(id: string, ejecutorId?: string) {
    return this.update(id, { activo: false }, ejecutorId);
  }

  /**
   * Evita el bloqueo total: siempre debe quedar al menos un SUPER_ADMIN activo.
   *
   * Es el rol crítico —sin él nadie puede gestionar agentes ni asignar los
   * códigos de empresa de los que depende la planilla— y además es el único que
   * puede volver a crear otro super admin.
   */
  private async verificarQueQuedaOtroSuperAdmin(excluyendoId: string, db: Prisma.TransactionClient = this.prisma): Promise<void> {
    const otros = await db.usuario.count({
      where: { rol: 'SUPER_ADMIN', activo: true, id: { not: excluyendoId } },
    });
    if (otros === 0) {
      throw new BadRequestException(
        'Es el último super administrador activo: asigna otro antes de desactivarlo o cambiar su rol.',
      );
    }
  }
}
