import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';

import { CurrentUser, UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ActualizarTipoCambioDto } from './dto/actualizar-tipo-cambio.dto';
import { ActualizarConfiguracionTipoCambioDto } from './dto/configuracion-tipo-cambio.dto';
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

  /**
   * El criterio de conversión vigente (fijo o automático) y con qué valor.
   *
   * Lo lee AGENTE por lo mismo que `vigente`: la pantalla necesita poder decir
   * "esto está en Bs a 6,97 fijo" junto al selector, y eso no expone nada.
   */
  @Get('configuracion')
  @Roles('AGENTE')
  configuracion() {
    return this.tipoCambioService.configuracion();
  }

  /**
   * Cambia el criterio de conversión de TODO el CRM. Solo SUPER_ADMIN: mueve a
   * la vez cada cifra en bolivianos que se ve en pantalla.
   *
   * **Va antes que `@Patch(':fecha')` a propósito**: `configuracion` no es una
   * fecha, y Nest resuelve por orden de declaración — declarado después, la
   * ruta comodín se lo comería y esto acabaría intentando parsear
   * "configuracion" como AAAA-MM-DD.
   */
  @Patch('configuracion')
  @Roles('SUPER_ADMIN')
  actualizarConfiguracion(
    @Body() dto: ActualizarConfiguracionTipoCambioDto,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    return this.tipoCambioService.actualizarConfiguracion(dto, usuario.sub);
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
