import type { CookieOptions, Request, Response } from 'express';
import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post, Req, Res } from '@nestjs/common';

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

  /**
   * Cierra la sesión: borra la cookie `refresh_token` del navegador.
   *
   * Sin esto, «cerrar sesión» solo vaciaba el localStorage del frontend y la
   * cookie —HttpOnly, 30 días— seguía siendo una credencial canjeable en
   * /auth/refresh por un access_token nuevo. En la clínica varias agentes
   * comparten equipo, así que la siguiente heredaba una sesión viva de la
   * anterior.
   *
   * **Lo que esto NO hace:** el JWT de refresco es sin estado, así que una
   * copia que ya hubiera salido del navegador sigue siendo válida hasta que
   * expire. Revocarlo de verdad exige guardar algo en la base —una columna
   * `sesionesValidasDesde` en Usuario contra la que comparar el `iat` del
   * token—, que es una migración y queda fuera de este arreglo. Esto cierra
   * el caso real y frecuente (el equipo compartido), no el robo de la cookie.
   *
   * `@Public()`: el que cierra sesión puede tener el access_token ya vencido
   * —es justo el caso—, y no poder salir por eso sería absurdo.
   */
  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(@Res({ passthrough: true }) res: Response): void {
    res.clearCookie('refresh_token', opcionesCookieRefresh());
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
