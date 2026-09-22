import { Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';

import { CurrentUser, UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { QueryResultadosDto } from './dto/query-resultados.dto';
import { ResultadosService } from './resultados.service';

/**
 * Entrega de informes del portal de resultados al WhatsApp del paciente.
 *
 * `@Roles('RECEPCION')` es el suelo de la jerarquía: exige sesión, nada más.
 * Quién puede entregar resultados lo decide la **membresía en la línea de
 * resultados**, que el service comprueba — el rango no sirve aquí, porque
 * ASISTENTE comparte rango con recepción y está por debajo de un agente de
 * ventas, que no debe entregar informes médicos.
 */
@Roles('RECEPCION')
@Controller('resultados')
export class ResultadosController {
  constructor(private readonly service: ResultadosService) {}

  /** Cola de entrega: informes publicados, con el paciente y si ya se avisó. */
  @Get('pendientes')
  pendientes(@Query() query: QueryResultadosDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.service.pendientes(query, usuario);
  }

  @Post(':informeId/enviar')
  enviar(
    @Param('informeId', ParseUUIDPipe) informeId: string,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    return this.service.enviar(informeId, usuario);
  }
}
