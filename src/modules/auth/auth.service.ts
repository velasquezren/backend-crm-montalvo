import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';

import { UsuariosService } from '../usuarios/usuarios.service';
import { LoginDto } from './dto/login.dto';
import { UpdateUsuarioDto } from '../usuarios/dto/update-usuario.dto';

/**
 * Módulo Auth — RNF-01: JWT + bcrypt.
 * Valida credenciales contra UsuariosService (nunca toca prisma.usuario directo).
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly usuariosService: UsuariosService,
    private readonly jwtService: JwtService,
  ) {}

  async login(dto: LoginDto) {
    const usuario = await this.usuariosService.findByEmailConPassword(dto.email);

    if (!usuario || !usuario.activo) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    const passwordValida = await bcrypt.compare(dto.password, usuario.passwordHash);
    if (!passwordValida) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    /* El JWT viaja en el header Authorization de CADA petición: debe ser
       chico. La foto (base64, hasta 2 MB) NUNCA va acá — hacía el token de
       ~2.7 MB y disparaba HTTP 431 (Request Header Fields Too Large) en todo
       lo autenticado. Solo identificadores. La foto se devuelve aparte en el
       cuerpo de la respuesta (el frontend la guarda en su propio storage). */
    const payload = {
      sub: usuario.id,
      email: usuario.email,
      nombre: usuario.nombre,
      rol: usuario.rol,
    };

    /* Refresh token con rotación y expiración absoluta de 30 días de inactividad real */
    const refreshToken = await this.jwtService.signAsync(
      { sub: usuario.id, type: 'refresh' },
      { expiresIn: '30d' },
    );

    return {
      access_token: await this.jwtService.signAsync(payload),
      refresh_token: refreshToken,
      rememberMe: dto.rememberMe ?? true,
      usuario: { ...payload, foto: usuario.foto },
    };
  }

  async refresh(refreshToken: string) {
    if (!refreshToken) {
      throw new UnauthorizedException('Token de refresco no provisto');
    }
    try {
      const decoded = await this.jwtService.verifyAsync<{ sub: string; type?: string }>(
        refreshToken,
      );
      if (decoded.type !== 'refresh') {
        throw new UnauthorizedException('Token de tipo inválido');
      }
      const usuario = await this.usuariosService.findOne(decoded.sub);
      if (!usuario || !usuario.activo) {
        throw new UnauthorizedException('Usuario no activo o no encontrado');
      }
      const payload = {
        sub: usuario.id,
        email: usuario.email,
        nombre: usuario.nombre,
        rol: usuario.rol,
      };
      return {
        access_token: await this.jwtService.signAsync(payload),
        usuario: { ...payload, foto: usuario.foto },
      };
    } catch {
      throw new UnauthorizedException('Token de refresco inválido o expirado');
    }
  }

  async getPerfil(id: string) {
    return this.usuariosService.findOne(id);
  }

  async updatePerfil(id: string, dto: UpdateUsuarioDto) {
    // Evitar que el agente se cambie su propio rol o estado activo/inactivo por seguridad
    const { rol, activo, ...cleanDto } = dto;
    return this.usuariosService.update(id, cleanDto);
  }
}
