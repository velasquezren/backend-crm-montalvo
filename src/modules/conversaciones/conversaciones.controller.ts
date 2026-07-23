import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';

import { CurrentUser, UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ConversacionesService } from './conversaciones.service';
import { AsignarAgenteDto } from './dto/asignar-agente.dto';
import { EnviarMensajeDto } from './dto/enviar-mensaje.dto';
import { EnviarPlantillaDto } from './dto/enviar-plantilla.dto';

@Controller('conversaciones')
export class ConversacionesController {
  constructor(private readonly conversacionesService: ConversacionesService) {}

  @Get()
  findAll(@CurrentUser() usuario: UsuarioJwt) {
    const soloAgenteId = usuario.rol === 'ADMIN' ? undefined : usuario.sub;
    return this.conversacionesService.findAll(soloAgenteId);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() usuario: UsuarioJwt) {
    const soloAgenteId = usuario.rol === 'ADMIN' ? undefined : usuario.sub;
    return this.conversacionesService.findOne(id, soloAgenteId);
  }

  @Post(':id/mensajes')
  enviarMensaje(
    @Param('id') id: string,
    @Body() dto: EnviarMensajeDto,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    const soloAgenteId = usuario.rol === 'ADMIN' ? undefined : usuario.sub;
    return this.conversacionesService.enviarMensaje(id, dto.contenido, usuario.sub, soloAgenteId);
  }

  /** Plantillas aprobadas de la WABA — para el selector al escribir fuera de la ventana de 24h. */
  @Get('meta/plantillas')
  listarPlantillas() {
    return this.conversacionesService.listarPlantillas();
  }

  /** Enviar una plantilla aprobada al paciente de esta conversación. */
  @Post(':id/plantilla')
  enviarPlantilla(
    @Param('id') id: string,
    @Body() dto: EnviarPlantillaDto,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    const soloAgenteId = usuario.rol === 'ADMIN' ? undefined : usuario.sub;
    return this.conversacionesService.enviarPlantilla(id, dto, usuario.sub, soloAgenteId);
  }

  /** Asignar agente a conversación — solo ADMIN. */
  @Patch(':id/agente')
  @Roles('ADMIN')
  asignarAgente(
    @Param('id') id: string,
    @Body() dto: AsignarAgenteDto,
  ) {
    return this.conversacionesService.asignarAgente(id, dto.agenteId);
  }

  /** Lista de agentes activos — para el dropdown de asignación del admin. */
  @Get('meta/agentes')
  findAgentes() {
    return this.conversacionesService.findAgentes();
  }
}
