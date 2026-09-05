import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';

import { alcanceAgente } from '../../common/auth/roles';
import { CurrentUser, UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { ActividadesService } from './actividades.service';
import { CreateActividadDto } from './dto/create-actividad.dto';
import { QueryActividadDto } from './dto/query-actividad.dto';
import { UpdateActividadDto } from './dto/update-actividad.dto';
import { UpdateEstadoActividadDto } from './dto/update-estado-actividad.dto';

@Controller('actividades')
export class ActividadesController {
  constructor(private readonly actividadesService: ActividadesService) {}

  @Get()
  findAll(@Query() query: QueryActividadDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.actividadesService.findAll(query, alcanceAgente(usuario));
  }

  /** Conteos de "Vencidas" / "Hoy" / "Próximos 7 días" para la cabecera de la vista. */
  @Get('resumen')
  resumen(@Query() query: QueryActividadDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.actividadesService.resumen(query, alcanceAgente(usuario));
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() usuario: UsuarioJwt) {
    return this.actividadesService.findOne(id, alcanceAgente(usuario));
  }

  @Post()
  create(@Body() dto: CreateActividadDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.actividadesService.create(dto, usuario);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateActividadDto,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    return this.actividadesService.update(id, dto, alcanceAgente(usuario));
  }

  @Patch(':id/estado')
  actualizarEstado(
    @Param('id') id: string,
    @Body() dto: UpdateEstadoActividadDto,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    return this.actividadesService.actualizarEstado(id, dto, alcanceAgente(usuario));
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() usuario: UsuarioJwt) {
    return this.actividadesService.remove(id, alcanceAgente(usuario));
  }
}
