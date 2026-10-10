import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser, UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AsistenteLineasService } from './asistente-lineas.service';
import { GuardarAsistenteDto } from './dto/guardar-asistente.dto';

/** Se configura junto con la línea, en la misma pantalla y con el mismo rol que el menú y el cobro. */
@Roles('SUPER_ADMIN')
@Controller('asistente')
export class AsistenteController {
  constructor(private readonly service: AsistenteLineasService) {}

  /**
   * Prueba de punta a punta contra Google con datos sintéticos. Cuesta unas
   * pocas consultas: acotada a cinco por minuto.
   */
  @Post('probar')
  @HttpCode(200)
  @Throttle({ general: { ttl: 60_000, limit: 5 } })
  probar() {
    return this.service.probarConexion();
  }

  @Get('lineas/:lineaId')
  obtener(@Param('lineaId', ParseUUIDPipe) lineaId: string) {
    return this.service.editable(lineaId);
  }

  @Put('lineas/:lineaId')
  guardar(@Param('lineaId', ParseUUIDPipe) lineaId: string, @Body() dto: GuardarAsistenteDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.service.guardar(lineaId, dto, usuario.sub);
  }
}
