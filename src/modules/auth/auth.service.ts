import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';

import { UsuariosService } from '../usuarios/usuarios.service';
import { LoginDto } from './dto/login.dto';

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

    const payload = {
      sub: usuario.id,
      email: usuario.email,
      nombre: usuario.nombre,
      rol: usuario.rol,
    };

    return {
      access_token: await this.jwtService.signAsync(payload),
      usuario: payload,
    };
  }
}
