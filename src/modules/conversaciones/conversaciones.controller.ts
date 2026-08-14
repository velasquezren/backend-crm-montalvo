import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { alcanceAgente } from '../../common/auth/roles';
import { CurrentUser, UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ConversacionesService } from './conversaciones.service';
import { AsignarAgenteDto } from './dto/asignar-agente.dto';
import { EnviarMensajeDto } from './dto/enviar-mensaje.dto';
import { EnviarPlantillaDto } from './dto/enviar-plantilla.dto';
import { MarcarLeidoDto } from './dto/marcar-leido.dto';
import { QueryBuscarMensajesDto } from './dto/query-buscar-mensajes.dto';
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

  /** Plantillas aprobadas de la WABA — para el selector al escribir fuera de la ventana de 24h. */
  @Get('meta/plantillas')
  listarPlantillas(@Query('refresh') refresh?: string) {
    return this.conversacionesService.listarPlantillas(refresh === 'true');
  }

  /** Agentes activos — alimenta los desplegables y lectura de agente asignado en CRM. */
  @Get('meta/agentes')
  findAgentes() {
    return this.conversacionesService.findAgentes();
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

  /** Busca en el historial completo del chat, no solo en lo que el navegador
   *  tiene cargado. El `alcanceAgente()` no es opcional: sin él, cualquiera con
   *  un id de conversación podría leer el historial de la paciente de otra
   *  agente escribiendo en el buscador. */
  @Get(':id/buscar-mensajes')
  buscarMensajes(
    @Param('id') id: string,
    @Query() query: QueryBuscarMensajesDto,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    const soloAgenteId = alcanceAgente(usuario);
    return this.conversacionesService.buscarMensajes(
      id,
      query.query,
      query.limit ?? 20,
      query.skip ?? 0,
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
}
