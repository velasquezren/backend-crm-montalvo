import type { CookieOptions, Request, Response } from 'express';
import { Body, Controller, Get, Patch, Post, Req, Res } from '@nestjs/common';

import { CurrentUser, UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { Throttle } from '@nestjs/throttler';

import { Public } from '../../common/decorators/public.decorator';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { UpdateUsuarioDto } from '../usuarios/dto/update-usuario.dto';

function extraerCookie(headerCookie: string | undefined, nombre: string): string | undefined {
  if (!headerCookie) return undefined;
  const match = headerCookie.match(new RegExp(`(?:^|;\\s*)${nombre}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * Límite estricto contra fuerza bruta: 5 intentos por minuto y por IP.
   * Emite la cookie HttpOnly con o sin maxAge según rememberMe.
   */
  @Public()
  @Throttle({ general: { ttl: 60_000, limit: 5 } })
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const resultado = await this.authService.login(dto);
    const rememberMe = dto.rememberMe ?? true;

    if (resultado.refresh_token) {
      /* En producción el frontend (Vercel) y esta API viven en dominios
         distintos: es cross-site, no cross-origin del mismo sitio. Con
         `SameSite=Lax` el navegador nunca manda la cookie en el POST fetch a
         /auth/refresh —Lax solo la deja viajar en navegaciones de nivel
         superior—, así que el refresco silencioso jamás llegaría a
         dispararse. Cross-site exige `SameSite=None`, que a su vez exige
         `Secure`. En local (localhost:4200 → localhost:3001) sigue siendo el
         mismo sitio y basta con `Lax`. */
      const produccion = process.env.NODE_ENV === 'production';
      const cookieOptions: CookieOptions = {
        httpOnly: true,
        secure: produccion,
        sameSite: produccion ? 'none' : 'lax',
        path: '/',
      };

      if (rememberMe) {
        // 30 días de persistencia si rememberMe = true
        cookieOptions.maxAge = 30 * 24 * 60 * 60 * 1000;
      }
      // Si rememberMe = false: cookie de sesión (sin maxAge, se borra al cerrar el navegador/PWA)

      res.cookie('refresh_token', resultado.refresh_token, cookieOptions);
    }

    return resultado;
  }

  /**
   * Refresco de sesión silencioso mediante refresh_token (cookie o body).
   */
  @Public()
  @Post('refresh')
  async refresh(
    @Req() req: Request,
    @Body() dto: RefreshTokenDto,
  ) {
    const tokenCookie = extraerCookie(req.headers.cookie, 'refresh_token');
    const token = dto.refresh_token || tokenCookie;
    return this.authService.refresh(token ?? '');
  }

  /** Perfil del usuario autenticado — útil para restaurar sesión en el frontend. */
  @Get('perfil')
  perfil(@CurrentUser() usuario: UsuarioJwt) {
    return this.authService.getPerfil(usuario.sub);
  }

  @Patch('perfil')
  updatePerfil(@CurrentUser() usuario: UsuarioJwt, @Body() dto: UpdateUsuarioDto) {
    return this.authService.updatePerfil(usuario.sub, dto);
  }
}
