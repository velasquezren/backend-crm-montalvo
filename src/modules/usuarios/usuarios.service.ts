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
      if (resto.rol && resto.rol !== 'ADMIN') {
        throw new BadRequestException(
          'No puedes quitarte a ti mismo el rol de administrador.',
        );
      }
      if (resto.activo === false) {
        throw new BadRequestException('No puedes desactivar tu propia cuenta.');
      }
    }

    /* Tampoco se puede dejar el sistema sin ningún administrador activo. */
    const dejaDeSerAdmin =
      actual.rol === 'ADMIN' &&
      ((resto.rol && resto.rol !== 'ADMIN') || resto.activo === false);
    if (dejaDeSerAdmin) {
      await this.verificarQueQuedaOtroAdmin(id);
    }

    return this.prisma.usuario.update({
      where: { id },
      data: {
        ...resto,
        ...(password ? { passwordHash: await bcrypt.hash(password, 10) } : {}),
      },
      select: SIN_PASSWORD,
    });
  }

  /** Desactivación en vez de borrado — el historial de ventas/comisiones se preserva. */
  async desactivar(id: string, ejecutorId?: string) {
    const usuario = await this.findOne(id);

    if (ejecutorId && ejecutorId === id) {
      throw new BadRequestException('No puedes desactivar tu propia cuenta.');
    }
    if (usuario.rol === 'ADMIN') {
      await this.verificarQueQuedaOtroAdmin(id);
    }

    return this.prisma.usuario.update({
      where: { id },
      data: { activo: false },
      select: SIN_PASSWORD,
    });
  }

  /**
   * Eliminación física definitiva del usuario.
   * IMPORTANTE: No elimina ningún Cliente ni Lead (los 15k+ leads permanecen intactos):
   * solo desvincula el agenteId (dejándolos sin asignar) y elimina el usuario.
   *
   * Se BLOQUEA si el agente tiene ventas registradas: `Venta.agenteId` no es
   * nullable, así que borrar el usuario obligaría a borrar sus ventas (y sus
   * comisiones) — es decir, destruir historial de ingresos real y corromper
   * los KPIs. En ese caso el agente debe DESACTIVARSE (soft-delete), que lo
   * saca del sistema sin perder nada. El borrado físico queda solo para
   * agentes sin historial de ventas (ej. una cuenta creada por error).
   */
  async eliminarDefinitivamente(id: string, ejecutorId?: string) {
    const usuario = await this.findOne(id);

    if (ejecutorId && ejecutorId === id) {
      throw new BadRequestException('No puedes eliminar tu propia cuenta de administrador.');
    }
    if (usuario.rol === 'ADMIN') {
      await this.verificarQueQuedaOtroAdmin(id);
    }

    const ventas = await this.prisma.venta.count({ where: { agenteId: id } });
    if (ventas > 0) {
      throw new BadRequestException(
        `Este agente tiene ${ventas} venta(s) registrada(s): eliminarlo borraría ese historial de ingresos. ` +
          'Usa "Desactivar" en su lugar — lo saca del sistema conservando todo su historial.',
      );
    }

    await this.prisma.$transaction([
      this.prisma.cliente.updateMany({ where: { agenteId: id }, data: { agenteId: null } }),
      this.prisma.lead.updateMany({ where: { agenteId: id }, data: { agenteId: null } }),
      this.prisma.conversacion.updateMany({ where: { agenteId: id }, data: { agenteId: null } }),
      this.prisma.interes.updateMany({ where: { agenteId: id }, data: { agenteId: null } }),
      this.prisma.usuario.delete({ where: { id } }),
    ]);

    return { message: `Usuario ${usuario.nombre} eliminado permanentemente. Sus leads permanecen intactos y sin asignar.` };
  }

  /** Evita el bloqueo total: siempre debe quedar al menos un ADMIN activo. */
  private async verificarQueQuedaOtroAdmin(excluyendoId: string): Promise<void> {
    const otros = await this.prisma.usuario.count({
      where: { rol: 'ADMIN', activo: true, id: { not: excluyendoId } },
    });
    if (otros === 0) {
      throw new BadRequestException(
        'Es el último administrador activo: asigna otro antes de desactivarlo o cambiar su rol.',
      );
    }
  }
}
