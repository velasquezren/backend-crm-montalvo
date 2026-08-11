import { Body, Controller, Delete, Get, Post, Query } from '@nestjs/common';

import { CurrentUser, UsuarioJwt } from '../decorators/current-user.decorator';
import { DesuscribirPushDto } from './dto/desuscribir-push.dto';
import { SuscribirPushDto } from './dto/suscribir-push.dto';
import { PushService } from './push.service';

@Controller('push')
export class PushController {
  constructor(private readonly pushService: PushService) {}

  /** Clave pública VAPID que el navegador necesita para suscribirse. */
  @Get('public-key')
  getPublicKey() {
    return this.pushService.getPublicKey();
  }

  @Post('suscribir')
  suscribir(@CurrentUser() usuario: UsuarioJwt, @Body() dto: SuscribirPushDto) {
    return this.pushService.guardarSuscripcion(usuario.sub, dto);
  }

  /**
   * El `usuario.sub` acota el borrado a las suscripciones propias.
   *
   * Sin él, cualquiera autenticado que conociera el endpoint de otra agente la
   * dejaba sin notificaciones —y sin forma de enterarse—. El endpoint viaja al
   * navegador de quien se suscribe, así que no es un secreto en el que apoyarse.
   */
  @Delete('desuscribir')
  desuscribir(@CurrentUser() usuario: UsuarioJwt, @Query() query: DesuscribirPushDto) {
    return this.pushService.eliminarSuscripcionPropia(usuario.sub, query.endpoint);
  }
}
