import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';

import { CurrentUser, UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { QueryResultadosDto } from './dto/query-resultados.dto';
import { TelefonoPacienteDto } from './dto/telefono-paciente.dto';
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

  /**
   * El enlace para comprobar QUÉ informe se va a enviar: la vista del portal,
   * la misma del médico, abierta directo en el navegador.
   *
   * Antes el CRM traía el PDF y lo reenviaba: 3-5 MB pasando dos veces por el
   * servidor y bajando enteros antes de verse nada. Ahora el navegador lo carga
   * del portal con su propio visor y en la versión liviana. El enlace dura 10
   * minutos y no marca el informe como abierto por el paciente.
   */
  @Post(':informeId/revision')
  revision(@Param('informeId', ParseUUIDPipe) informeId: string, @CurrentUser() usuario: UsuarioJwt) {
    return this.service.enlaceRevision(informeId, usuario);
  }

  @Post(':informeId/enviar')
  enviar(
    @Param('informeId', ParseUUIDPipe) informeId: string,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    return this.service.enviar(informeId, usuario);
  }

  /**
   * Corrige el teléfono de la ficha a la que va el aviso de este informe. Va
   * aquí y no en `/clientes` porque esa ruta exige rango de agente: la
   * asistente actúa sobre el informe y el servidor decide qué ficha es.
   */
  @Patch(':informeId/telefono')
  corregirTelefono(
    @Param('informeId', ParseUUIDPipe) informeId: string,
    @Body() dto: TelefonoPacienteDto,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    return this.service.corregirTelefono(informeId, dto.telefono, usuario);
  }

  /** Alta de la ficha del paciente del informe: nombre y PAC salen del portal. */
  @Post(':informeId/ficha')
  crearFicha(
    @Param('informeId', ParseUUIDPipe) informeId: string,
    @Body() dto: TelefonoPacienteDto,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    return this.service.crearFicha(informeId, dto.telefono, usuario);
  }

  /** El enlace venció: se extiende 30 días y se vuelve a avisar al paciente. */
  @Post(':informeId/renovar-y-enviar')
  renovarYEnviar(
    @Param('informeId', ParseUUIDPipe) informeId: string,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    return this.service.renovarYEnviar(informeId, usuario);
  }
}
