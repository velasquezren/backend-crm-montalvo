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

    return this.prisma.usuario.create({
      data: {
        nombre: dto.nombre,
        email: dto.email,
        passwordHash: await bcrypt.hash(dto.password, 10),
        rol: dto.rol,
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
    const actual = await this.findOne(id);
    const { password, ...resto } = dto;

    /* Un admin no puede quitarse a sí mismo el rol ni desactivarse: se quedaría
       sin acceso a la gestión y, si es el único, nadie podría recuperarla. */
    if (ejecutorId && ejecutorId === id) {
      if (resto.rol && resto.rol !== actual.rol) {
        throw new BadRequestException('No puedes cambiarte a ti mismo el rol.');
      }
      if (resto.activo === false) {
        throw new BadRequestException('No puedes desactivar tu propia cuenta.');
      }
    }

    /* Tampoco se puede dejar el sistema sin ningún super administrador activo. */
    const dejaDeSerSuperAdmin =
      actual.rol === 'SUPER_ADMIN' &&
      ((resto.rol && resto.rol !== 'SUPER_ADMIN') || resto.activo === false);
    if (dejaDeSerSuperAdmin) {
      await this.verificarQueQuedaOtroSuperAdmin(id);
    }

    return this.prisma.usuario.update({
      where: { id },
      data: {
        ...resto,
        ...(resto.codigo !== undefined
          ? { codigo: await this.normalizarCodigo(resto.codigo, id) }
          : {}),
        ...(password ? { passwordHash: await bcrypt.hash(password, 10) } : {}),
      },
      select: SIN_PASSWORD,
    });
  }

  /**
   * El código de empresa es único. El vacío se guarda como `null`, no como '':
   * varias cadenas vacías chocarían contra el índice único, mientras que Postgres
   * permite tantos NULL como haga falta.
   */
  private async normalizarCodigo(codigo: string | undefined, exceptoId?: string) {
    const limpio = codigo?.trim();
    if (!limpio) return null;

    const enUso = await this.prisma.usuario.findUnique({
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
    const usuario = await this.findOne(id);

    if (ejecutorId && ejecutorId === id) {
      throw new BadRequestException('No puedes desactivar tu propia cuenta.');
    }
    if (usuario.rol === 'SUPER_ADMIN') {
      await this.verificarQueQuedaOtroSuperAdmin(id);
    }

    return this.prisma.usuario.update({
      where: { id },
      data: { activo: false },
      select: SIN_PASSWORD,
    });
  }

  /**
   * Evita el bloqueo total: siempre debe quedar al menos un SUPER_ADMIN activo.
   *
   * Es el rol crítico —sin él nadie puede gestionar agentes ni asignar los
   * códigos de empresa de los que depende la planilla— y además es el único que
   * puede volver a crear otro super admin.
   */
  private async verificarQueQuedaOtroSuperAdmin(excluyendoId: string): Promise<void> {
    const otros = await this.prisma.usuario.count({
      where: { rol: 'SUPER_ADMIN', activo: true, id: { not: excluyendoId } },
    });
    if (otros === 0) {
      throw new BadRequestException(
        'Es el último super administrador activo: asigna otro antes de desactivarlo o cambiar su rol.',
      );
    }
  }
}
