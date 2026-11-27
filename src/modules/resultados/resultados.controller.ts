import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';

import { CurrentUser, UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ConstanciaResultadosService } from './constancia-resultados.service';
import { AnularValidacionDto, ImpresionConstanciaDto, MesConstanciaDto } from './dto/mes-constancia.dto';
import { QueryConstanciaDto } from './dto/query-constancia.dto';
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
  constructor(
    private readonly service: ResultadosService,
    private readonly constancia: ConstanciaResultadosService,
  ) {}

  /** Cola de entrega: informes publicados, con el paciente y si ya se avisó. */
  @Get('pendientes')
  pendientes(@Query() query: QueryResultadosDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.service.pendientes(query, usuario);
  }

  /**
   * Constancia mensual de entregas para notariar: cada aviso enviado en el mes
   * con su número, informe, entrega por WhatsApp y apertura en el portal.
   *
   * Solo administración (ADMIN cubre a SUPER_ADMIN): son todos los pacientes
   * del mes, de las dos líneas —Recepción y Laboratorio—, no la cola de quien
   * entrega. Paginada; la pantalla de impresión trae todas las páginas.
   */
  @Roles('ADMIN')
  @Get('constancia')
  constanciaMensual(@Query() query: QueryConstanciaDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.constancia.mensual(query, usuario);
  }

  /**
   * Los últimos 12 meses de la constancia: avisos, si el mes está validado y
   * quién imprimió por última vez. Solo administración, como la constancia.
   */
  @Roles('ADMIN')
  @Get('constancia/meses')
  mesesDeConstancia() {
    return this.constancia.meses();
  }

  /**
   * Deja constancia de una impresión (quién, cuándo, qué recorte). La pantalla
   * no imprime si esto falla: el registro de quién imprimió es el pedido.
   */
  @Roles('ADMIN')
  @Post('constancia/:mes/impresion')
  registrarImpresion(@Param() { mes }: MesConstanciaDto, @Body() dto: ImpresionConstanciaDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.constancia.registrarImpresion(mes, dto, usuario);
  }

  /**
   * Valida un mes ya cerrado y congela su constancia. Solo SUPER_ADMIN
   * (27/11/2026, René): validar es cerrar el mes que se lleva a notariar.
   */
  @Roles('SUPER_ADMIN')
  @Post('constancia/:mes/validacion')
  validarMes(@Param() { mes }: MesConstanciaDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.constancia.validar(mes, usuario);
  }

  /**
   * Anula la validación, con motivo. La copia pasa a la auditoría. Solo
   * SUPER_ADMIN. POST y no DELETE: lleva cuerpo (el motivo), y un DELETE con
   * cuerpo lo descartan algunos proxies y el cliente HTTP del frontend.
   */
  @Roles('SUPER_ADMIN')
  @Post('constancia/:mes/validacion/anular')
  @HttpCode(HttpStatus.NO_CONTENT)
  anularValidacion(@Param() { mes }: MesConstanciaDto, @Body() dto: AnularValidacionDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.constancia.anularValidacion(mes, dto.motivo, usuario);
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

  /**
   * El número ya tiene ficha sin PAC y la asistente confirmó que es la misma
   * paciente: se le pone el PAC del informe. La ficha la busca el servidor por
   * ese teléfono.
   */
  @Post(':informeId/vincular')
  vincularFicha(
    @Param('informeId', ParseUUIDPipe) informeId: string,
    @Body() dto: TelefonoPacienteDto,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    return this.service.vincularFicha(informeId, dto.telefono, usuario);
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
