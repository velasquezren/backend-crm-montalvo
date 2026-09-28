import { Controller, Get, Header, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';

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

  /**
   * El PDF, para comprobar QUÉ informe se va a enviar.
   *
   * Lo sirve el CRM en vez de enlazar al portal porque el enlace del paciente
   * marca `abiertoEn`: si lo abriera la asistente, la fila diría «Abierto por
   * el paciente» y esa señal —la que dice a quién hay que seguir— se volvería
   * mentira.
   *
   * `inline` para que se vea en el navegador y no se descargue.
   */
  @Get(':informeId/pdf')
  @Header('Content-Type', 'application/pdf')
  @Header('Content-Disposition', 'inline; filename="informe.pdf"')
  @Header('Cache-Control', 'no-store, private')
  pdf(@Param('informeId', ParseUUIDPipe) informeId: string, @CurrentUser() usuario: UsuarioJwt) {
    return this.service.pdf(informeId, usuario);
  }

  @Post(':informeId/enviar')
  enviar(
    @Param('informeId', ParseUUIDPipe) informeId: string,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    return this.service.enviar(informeId, usuario);
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
