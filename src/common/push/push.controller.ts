import { Body, Controller, Delete, Get, Post, Query } from '@nestjs/common';
import { CurrentUser, UsuarioJwt } from '../decorators/current-user.decorator';
import { PushService } from './push.service';

export class SuscribirPushDto {
  endpoint!: string;
  keys!: {
    p256dh: string;
    auth: string;
  };
}

@Controller('push')
export class PushController {
  constructor(private readonly pushService: PushService) {}

  @Get('public-key')
  getPublicKey() {
    return this.pushService.getPublicKey();
  }

  @Post('suscribir')
  suscribir(@CurrentUser() usuario: UsuarioJwt, @Body() body: SuscribirPushDto) {
    return this.pushService.guardarSuscripcion(usuario.sub, body);
  }

  @Delete('desuscribir')
  desuscribir(@Query('endpoint') endpoint: string) {
    return this.pushService.eliminarSuscripcion(endpoint);
  }
}
