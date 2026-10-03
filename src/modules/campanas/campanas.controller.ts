import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';

import { CurrentUser, UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AudienciasService } from './audiencias.service';
import { CampanasService } from './campanas.service';
import { CrearCampanaDto } from './dto/crear-campana.dto';
import { QueryAudienciaDto } from './dto/query-audiencia.dto';
import { QueryCampanasDto, QueryDestinatariosDto } from './dto/query-campanas.dto';

/**
 * Campañas: administración las ve —con su audiencia—; solo SUPER_ADMIN las
 * lanza y las controla. Las agentes son ADMIN para cooperar en el chat, y una
 * campaña escribe a cientos de pacientes y se paga.
 */
@Controller('campanas')
@Roles('ADMIN')
export class CampanasController {
  constructor(
    private readonly campanas: CampanasService,
    private readonly audiencias: AudienciasService,
  ) {}

  /**
   * Quiénes recibirían una campaña hoy, con el embudo de por qué el resto no.
   * Va ANTES de `:id`: Express casa las rutas en el orden en que se declaran,
   * y declarada después «audiencia» se leería como el id de una campaña.
   */
  @Get('audiencia')
  audiencia(@Query() query: QueryAudienciaDto) {
    return this.audiencias.segmentar(query);
  }

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
