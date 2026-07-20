import { Body, Controller, Get, Param, Post } from '@nestjs/common';

import { CurrentUser, UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { ConversacionesService } from './conversaciones.service';
import { EnviarMensajeDto } from './dto/enviar-mensaje.dto';

@Controller('conversaciones')
export class ConversacionesController {
  constructor(private readonly conversacionesService: ConversacionesService) {}

  @Get()
  findAll(@CurrentUser() usuario: UsuarioJwt) {
    const soloAgenteId = usuario.rol === 'ADMIN' ? undefined : usuario.sub;
    return this.conversacionesService.findAll(soloAgenteId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.conversacionesService.findOne(id);
  }

  @Post(':id/mensajes')
  enviarMensaje(
    @Param('id') id: string,
    @Body() dto: EnviarMensajeDto,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    return this.conversacionesService.enviarMensaje(id, dto.contenido, usuario.sub);
  }
}
