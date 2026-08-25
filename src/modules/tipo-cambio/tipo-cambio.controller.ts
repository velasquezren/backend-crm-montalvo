import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';

import { CurrentUser, UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ActualizarTipoCambioDto } from './dto/actualizar-tipo-cambio.dto';
import { QueryTipoCambioDto } from './dto/query-tipo-cambio.dto';
import { TipoCambioService } from './tipo-cambio.service';

@Controller('tipo-cambio')
@Roles('ADMIN')
export class TipoCambioController {
  constructor(private readonly tipoCambioService: TipoCambioService) {}

  /**
   * Tipo de cambio vigente, para el selector Bs/$us del navbar.
   * Va abierto a AGENTE —el resto del controlador es ADMIN— por lo mismo que
   * su equivalente de planilla-comisiones: lo ve todo el mundo y no expone
   * nada de comisiones ni de pacientes, solo la cotización del día.
   */
  @Get('vigente')
  @Roles('AGENTE')
  vigente() {
    return this.tipoCambioService.vigente();
  }

  /** Serie de un mes calendario, para la pantalla de administración. */
  @Get('historial')
  historial(@Query() query: QueryTipoCambioDto) {
    return this.tipoCambioService.historial(query.anio, query.mes);
  }

  /** Corrección manual de un día concreto (AAAA-MM-DD) — siempre gana sobre lo automático. */
  @Patch(':fecha')
  corregir(
    @Param('fecha') fecha: string,
    @Body() dto: ActualizarTipoCambioDto,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    return this.tipoCambioService.corregirManual(fecha, dto.valor, usuario.sub);
  }

  /** Reintento manual del fetch automático (ej. si el espejo falló y ya se restableció). */
  @Post('sincronizar')
  @HttpCode(HttpStatus.OK)
  sincronizar() {
    return this.tipoCambioService.sincronizarAutomatico();
  }
}
