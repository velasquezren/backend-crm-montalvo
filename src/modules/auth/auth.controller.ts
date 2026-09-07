import type { CookieOptions, Request, Response } from 'express';
import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post, Req, Res } from '@nestjs/common';

import { CurrentUser, UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { Throttle } from '@nestjs/throttler';

import { Public } from '../../common/decorators/public.decorator';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { UpdatePerfilDto } from './dto/update-perfil.dto';

function extraerCookie(headerCookie: string | undefined, nombre: string): string | undefined {
  if (!headerCookie) return undefined;
  const match = headerCookie.match(new RegExp(`(?:^|;\\s*)${nombre}=([^;]+)`));
  if (!match) return undefined;
  try { return decodeURIComponent(match[1]); } catch { return undefined; }
}

/**
 * Atributos de la cookie `refresh_token`, en un solo sitio.
 *
 * En producción el frontend (Vercel) y esta API viven en dominios distintos:
 * es cross-site, no cross-origin del mismo sitio. Con `SameSite=Lax` el
 * navegador nunca manda la cookie en el POST fetch a /auth/refresh —Lax solo
 * la deja viajar en navegaciones de nivel superior—, así que el refresco
 * silencioso jamás llegaría a dispararse. Cross-site exige `SameSite=None`,
 * que a su vez exige `Secure`. En local (localhost:4200 → localhost:3001)
 * sigue siendo el mismo sitio y basta con `Lax`.
 *
 * Está factorizado porque `clearCookie` solo borra si `path`, `sameSite` y
 * `secure` coinciden con los del `res.cookie` que la emitió: si login y
 * logout divergen, el logout falla en silencio y la cookie sigue viva.
 */
function opcionesCookieRefresh(): CookieOptions {
  const produccion = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: produccion,
    sameSite: produccion ? 'none' : 'lax',
    path: '/',
  };
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
      const cookieOptions: CookieOptions = opcionesCookieRefresh();

      if (rememberMe) {
        // 30 días de persistencia si rememberMe = true
        cookieOptions.maxAge = 30 * 24 * 60 * 60 * 1000;
      }
      // Si rememberMe = false: cookie de sesión (sin maxAge, se borra al cerrar el navegador/PWA)

      res.cookie('refresh_token', resultado.refresh_token, cookieOptions);
    }

    const { refresh_token: _refreshToken, ...respuesta } = resultado;
    return respuesta;
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
    const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
    return this.authService.refresh(token ?? '', bearer);
  }

  /** Revoca esta sesión y borra su cookie, incluso con access expirado. */
  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const cookie = extraerCookie(req.headers.cookie, 'refresh_token');
    const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
    const borrarCookie = await this.authService.logout(bearer || cookie || '', bearer ? 'access' : 'refresh', cookie);
    if (borrarCookie) res.clearCookie('refresh_token', opcionesCookieRefresh());
  }

  /** Perfil del usuario autenticado — útil para restaurar sesión en el frontend. */
  @Get('perfil')
  perfil(@CurrentUser() usuario: UsuarioJwt) {
    return this.authService.getPerfil(usuario.sub);
  }

  @Patch('perfil')
  updatePerfil(@CurrentUser() usuario: UsuarioJwt, @Body() dto: UpdatePerfilDto) {
    return this.authService.updatePerfil(usuario.sub, dto);
  }
}
