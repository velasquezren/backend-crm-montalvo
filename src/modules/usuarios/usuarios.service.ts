import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
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

  async update(id: string, dto: UpdateUsuarioDto) {
    await this.findOne(id);
    const { password, ...resto } = dto;

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
  async desactivar(id: string) {
    await this.findOne(id);
    return this.prisma.usuario.update({
      where: { id },
      data: { activo: false },
      select: SIN_PASSWORD,
    });
  }
}
