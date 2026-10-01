import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';

import { CurrentUser, UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CampanasService } from './campanas.service';
import { CrearCampanaDto } from './dto/crear-campana.dto';
import { QueryCampanasDto, QueryDestinatariosDto } from './dto/query-campanas.dto';

/**
 * Campañas: administración las ve; solo SUPER_ADMIN las lanza y las controla.
 * Las agentes son ADMIN para cooperar en el chat, y una campaña escribe a
 * cientos de pacientes y se paga.
 */
@Controller('campanas')
@Roles('ADMIN')
export class CampanasController {
  constructor(private readonly campanas: CampanasService) {}

  @Get()
  listar(@Query() query: QueryCampanasDto) {
    return this.campanas.listar(query);
  }

  @Get(':id')
  detalle(@Param('id') id: string) {
    return this.campanas.detalle(id);
  }

  @Get(':id/destinatarios')
  destinatarios(@Param('id') id: string, @Query() query: QueryDestinatariosDto) {
    return this.campanas.destinatarios(id, query);
  }

  @Post()
  @Roles('SUPER_ADMIN')
  crear(@Body() dto: CrearCampanaDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.campanas.crear(dto, usuario.sub);
  }

  @Post(':id/pausar')
  @Roles('SUPER_ADMIN')
  pausar(@Param('id') id: string, @CurrentUser() usuario: UsuarioJwt) {
    return this.campanas.pausar(id, usuario.sub);
  }

  @Post(':id/reanudar')
  @Roles('SUPER_ADMIN')
  reanudar(@Param('id') id: string, @CurrentUser() usuario: UsuarioJwt) {
    return this.campanas.reanudar(id, usuario.sub);
  }

  @Post(':id/cancelar')
  @Roles('SUPER_ADMIN')
  cancelar(@Param('id') id: string, @CurrentUser() usuario: UsuarioJwt) {
    return this.campanas.cancelar(id, usuario.sub);
  }
}
