import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
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

    /* Refresh token de 30 días **absolutos desde el login**: no rota ni se
       renueva al usarlo (`refresh()` solo emite un access_token nuevo), así
       que no es una ventana deslizante de inactividad. Se invalida cerrando
       sesión —`POST /auth/logout` borra la cookie— o dejándolo expirar. */
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

  /**
   * Canjea un `refresh_token` por un `access_token` nuevo.
   *
   * **Solo lo que de verdad invalida la sesión responde 401.** El `try` cubre
   * únicamente la verificación de la firma: envolver también la consulta a la
   * base convertía un parpadeo de Postgres en «token inválido», y el
   * interceptor del frontend reacciona a ese 401 cerrando la sesión y mandando
   * al login. Una caída transitoria de la base echaba a todas las agentes a la
   * vez, en vez de darles un 500 que se reintenta. Todo lo que no sea un
   * problema de credenciales sube tal cual y sale como 500.
   */
  async refresh(refreshToken: string) {
    if (!refreshToken) {
      throw new UnauthorizedException('Token de refresco no provisto');
    }

    let decoded: { sub: string; type?: string };
    try {
      decoded = await this.jwtService.verifyAsync<{ sub: string; type?: string }>(refreshToken);
    } catch {
      throw new UnauthorizedException('Token de refresco inválido o expirado');
    }

    /* Un access_token no lleva `type`, así que no se puede colar como refresco. */
    if (decoded.type !== 'refresh') {
      throw new UnauthorizedException('Token de tipo inválido');
    }

    let usuario: Awaited<ReturnType<UsuariosService['findOne']>>;
    try {
      usuario = await this.usuariosService.findOne(decoded.sub);
    } catch (error) {
      /* Usuario borrado: la sesión ya no vale, 401. Cualquier otro fallo
         —la base no responde— se re-lanza a propósito. */
      if (error instanceof NotFoundException) {
        throw new UnauthorizedException('Usuario no activo o no encontrado');
      }
      throw error;
    }

    if (!usuario.activo) {
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
