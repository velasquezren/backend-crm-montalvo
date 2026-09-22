import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';

import { Roles } from '../../common/decorators/roles.decorator';
import { alcanceAgente } from '../../common/auth/roles';
import { CurrentUser, UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { ActividadesService } from './actividades.service';
import { CambiarHoraFuturasDto } from './dto/cambiar-hora-futuras.dto';
import { CreateActividadDto } from './dto/create-actividad.dto';
import { QueryActividadDto } from './dto/query-actividad.dto';
import { UpdateActividadDto } from './dto/update-actividad.dto';
import { UpdateEstadoActividadDto } from './dto/update-estado-actividad.dto';

@Roles('RECEPCION')
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

  /** Contactos mínimos para agendar, limitados a los chats accesibles. */
  @Get('pacientes')
  pacientes(@Query() query: QueryActividadDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.actividadesService.buscarPacientes(query, usuario);
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
    return this.actividadesService.update(id, dto, alcanceAgente(usuario), usuario);
  }

  @Patch(':id/estado')
  actualizarEstado(
    @Param('id') id: string,
    @Body() dto: UpdateEstadoActividadDto,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    return this.actividadesService.actualizarEstado(id, dto, alcanceAgente(usuario));
  }

  /* ── «Esta y las siguientes» ──────────────────────────────────────────
   *
   * Dos rutas pequeñas en vez de un `alcance` en el PATCH general, y es
   * deliberado: aquel DTO admite ocho campos —`clienteId` y `agenteId` entre
   * ellos—, así que propagar por descuido habría significado cambiarle el
   * paciente o el dueño a doce actividades. Con estos cuerpos eso no se puede
   * ni escribir.
   *
   * «Futuras» incluye siempre a la ocurrencia elegida; ver `origenDeSerie`.
   */

  @Patch(':id/esta-y-siguientes/hora')
  cambiarHoraDeFuturas(
    @Param('id') id: string,
    @Body() dto: CambiarHoraFuturasDto,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    return this.actividadesService.cambiarHoraDeFuturas(id, dto.hora, alcanceAgente(usuario));
  }

  @Patch(':id/esta-y-siguientes/cancelar')
  cancelarFuturas(@Param('id') id: string, @CurrentUser() usuario: UsuarioJwt) {
    return this.actividadesService.cancelarFuturas(id, alcanceAgente(usuario));
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() usuario: UsuarioJwt) {
    return this.actividadesService.remove(id, alcanceAgente(usuario));
  }
}
