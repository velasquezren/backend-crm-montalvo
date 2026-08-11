import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';

import { alcanceAgente } from '../../common/auth/roles';
import { CurrentUser, UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ConversacionesService } from './conversaciones.service';
import { AsignarAgenteDto } from './dto/asignar-agente.dto';
import { EnviarMensajeDto } from './dto/enviar-mensaje.dto';
import { EnviarPlantillaDto } from './dto/enviar-plantilla.dto';
import { MarcarLeidoDto } from './dto/marcar-leido.dto';
import { QueryConversacionesDto } from './dto/query-conversaciones.dto';
import { QueryMensajesAnterioresDto } from './dto/query-mensajes-anteriores.dto';

@Controller('conversaciones')
export class ConversacionesController {
  constructor(private readonly conversacionesService: ConversacionesService) {}

  /**
   * El alcance por rol y el interruptor "solo míos" van por parámetros
   * distintos a propósito: el primero es permiso y el segundo preferencia de
   * vista. Pasar el interruptor como si fuera el alcance —que es como estaba—
   * hace que un cambio de la interfaz redefina quién ve los datos de qué
   * paciente.
   */
  @Get()
  findAll(@CurrentUser() usuario: UsuarioJwt, @Query() query: QueryConversacionesDto) {
    return this.conversacionesService.findAll(
      alcanceAgente(usuario),
      query.soloMios ? usuario.sub : undefined,
    );
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() usuario: UsuarioJwt) {
    const soloAgenteId = alcanceAgente(usuario);
    return this.conversacionesService.findOne(id, soloAgenteId);
  }

  @Get(':id/mensajes-anteriores')
  obtenerMensajesAnteriores(
    @Param('id') id: string,
    @Query() query: QueryMensajesAnterioresDto,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    const soloAgenteId = alcanceAgente(usuario);
    return this.conversacionesService.obtenerMensajesAnteriores(
      id,
      query.antesDe,
      query.limit ?? 50,
      soloAgenteId,
    );
  }

  @Post(':id/mensajes')
  enviarMensaje(
    @Param('id') id: string,
    @Body() dto: EnviarMensajeDto,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    const soloAgenteId = alcanceAgente(usuario);
    return this.conversacionesService.enviarMensaje(id, dto.contenido, usuario.sub, soloAgenteId, {
      mediaKey: dto.mediaKey,
      mediaMime: dto.mediaMime,
      mediaNombre: dto.mediaNombre,
    });
  }

  /** Marca como leído (tildes azules) el último mensaje entrante; `typing` muestra "escribiendo…". */
  @Post(':id/leido')
  marcarLeido(
    @Param('id') id: string,
    @Body() dto: MarcarLeidoDto,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    const soloAgenteId = alcanceAgente(usuario);
    return this.conversacionesService.marcarLeido(id, soloAgenteId, dto.typing ?? false);
  }

  /** Plantillas aprobadas de la WABA — para el selector al escribir fuera de la ventana de 24h. */
  @Get('meta/plantillas')
  listarPlantillas(@Query('refresh') refresh?: string) {
    return this.conversacionesService.listarPlantillas(refresh === 'true');
  }

  /** Enviar una plantilla aprobada al paciente de esta conversación. */
  @Post(':id/plantilla')
  enviarPlantilla(
    @Param('id') id: string,
    @Body() dto: EnviarPlantillaDto,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    const soloAgenteId = alcanceAgente(usuario);
    return this.conversacionesService.enviarPlantilla(id, dto, usuario.sub, soloAgenteId);
  }

  /** Asignar agente a conversación — solo ADMIN. */
  @Patch(':id/agente')
  @Roles('ADMIN')
  asignarAgente(
    @Param('id') id: string,
    @Body() dto: AsignarAgenteDto,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    /* `usuario.sub` va para el AuditLog: reasignar mueve al cliente y a sus
       leads, y tiene que quedar constancia de quién lo hizo. */
    return this.conversacionesService.asignarAgente(id, dto.agenteId, usuario.sub);
  }

  /** Lista de agentes activos — para el dropdown de asignación del admin.
   *  `@Roles('ADMIN')` porque es lo único que la consume (el frontend solo la
   *  pide `if (isAdmin())`): sin esto, cualquier AGENTE listaba a toda la
   *  plantilla activa con su rol. */
  @Get('meta/agentes')
  @Roles('ADMIN')
  findAgentes() {
    return this.conversacionesService.findAgentes();
  }
}
