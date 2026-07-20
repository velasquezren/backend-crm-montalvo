import { Body, Controller, Get, Post } from '@nestjs/common';

import { CurrentUser, UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  /** Perfil del usuario autenticado — útil para restaurar sesión en el frontend. */
  @Get('perfil')
  perfil(@CurrentUser() usuario: UsuarioJwt) {
    return usuario;
  }
}
