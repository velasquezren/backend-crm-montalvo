import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { alcanceAgente, tieneAlcanceGlobal } from '../../common/auth/roles';
import { CurrentUser, UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ConversacionesService } from './conversaciones.service';
import { EnvioPlantillasService } from './envio-plantillas.service';
import { AtencionHumanaService } from './atencion-humana.service';
import { PromocionesChatService } from './promociones-chat.service';
import { PedirOtroComprobanteDto } from './dto/pedir-otro-comprobante.dto';
import { AsignarAgenteDto } from './dto/asignar-agente.dto';
import { EnviarMensajeDto } from './dto/enviar-mensaje.dto';
import { EnviarPlantillaDto } from './dto/enviar-plantilla.dto';
import { EnviarUbicacionDto } from './dto/enviar-ubicacion.dto';
import { IniciarConversacionDto } from './dto/iniciar-conversacion.dto';
import { MarcarLeidoDto } from './dto/marcar-leido.dto';
import { QueryBuscarMensajesDto } from './dto/query-buscar-mensajes.dto';
import { QueryConversacionesDto } from './dto/query-conversaciones.dto';
import { QueryMensajesAnterioresDto } from './dto/query-mensajes-anteriores.dto';

@Roles('RECEPCION')
@Controller('conversaciones')
export class ConversacionesController {
  constructor(
    private readonly conversacionesService: ConversacionesService,
    private readonly plantillas: EnvioPlantillasService,
    private readonly atencion: AtencionHumanaService,
    private readonly promocionesChat: PromocionesChatService,
  ) {}

  /**
   * El alcance por rol y el interruptor "solo míos" van por parámetros
   * distintos a propósito: el primero es permiso y el segundo preferencia de
   * vista. Pasar el interruptor como si fuera el alcance —que es como estaba—
   * hace que un cambio de la interfaz redefina quién ve los datos de qué
   * paciente.
   */
  @Get()
  findAll(@CurrentUser() usuario: UsuarioJwt, @Query() query: QueryConversacionesDto) {
    return this.conversacionesService.findAll(alcanceAgente(usuario), usuario.sub, query);
  }

  /**
   * Una sola fila del inbox, para refrescar por WebSocket lo que cambió sin
   * recargar la página entera.
   *
   * Recibe los mismos filtros de vista que el listado porque la respuesta
   * depende de ellos: si la conversación ya no encaja en la pestaña activa
   * —le contestaron y estás en "Sin responder"— devuelve `conversacion: null`
   * y el navegador la quita, en vez de dejar una fila que ya no corresponde.
   */
  @Get(':id/resumen')
  resumenParaInbox(
    @Param('id') id: string,
    @CurrentUser() usuario: UsuarioJwt,
    @Query() query: QueryConversacionesDto,
  ) {
    return this.conversacionesService.resumenParaInbox(
      id,
      alcanceAgente(usuario),
      usuario.sub,
      query,
    );
  }

  /**
   * Escribirle primero a una paciente o a un número nuevo, desde una línea.
   * Va antes de las rutas con `:id` para que `iniciar` no se lea como un id.
   */
  @Post('iniciar')
  iniciar(@Body() dto: IniciarConversacionDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.plantillas.iniciarConversacion(dto, usuario.sub, alcanceAgente(usuario));
  }

  /** Plantillas aprobadas de la WABA — para el selector al escribir fuera de la ventana de 24h. */
  @Get('meta/plantillas')
  listarPlantillas(@CurrentUser() usuario: UsuarioJwt, @Query('refresh') refresh?: string, @Query('lineaId') lineaId?: string) {
    return this.plantillas.listarPlantillas(refresh === 'true', lineaId, alcanceAgente(usuario));
  }

  /** Agentes activos — alimenta los desplegables y lectura de agente asignado en CRM. */
  @Get('meta/agentes')
  @Roles('ADMIN')
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
      query.antesDeId,
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
    }, dto.clientMessageId, dto.interaccion);
  }

  /**
   * Reenviar un mensaje que Meta rechazó, una vez resuelta la causa (la cuenta
   * de Meta, la red). Quien ve el chat; dentro de la ventana de 24 h.
   */
  @Post(':id/mensajes/:mensajeId/reenviar')
  reenviarMensaje(
    @Param('id') id: string,
    @Param('mensajeId') mensajeId: string,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    return this.conversacionesService.reenviarMensaje(id, mensajeId, usuario.sub, alcanceAgente(usuario));
  }

  /** El pin de ubicación de la clínica (Maps/Waze de un toque). Dentro de la ventana de 24 h. */
  @Post(':id/ubicacion')
  enviarUbicacion(
    @Param('id') id: string,
    @Body() dto: EnviarUbicacionDto,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    return this.conversacionesService.enviarUbicacion(id, usuario.sub, alcanceAgente(usuario), dto.clientMessageId);
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

  /**
   * Cerrar = resuelta: sale de las pestañas de trabajo y de sus contadores. Se
   * reabre sola si la paciente escribe o la clínica le contesta. Mismo permiso
   * que leer y responder esa conversación.
   */
  @Post(':id/cerrar')
  cerrar(@Param('id') id: string, @CurrentUser() usuario: UsuarioJwt) {
    return this.conversacionesService.cerrar(id, usuario.sub, alcanceAgente(usuario));
  }

  /**
   * Atención humana (docs/atencion-humana.md). Mismo permiso que leer y
   * responder la conversación; la regla de cada transición vive en
   * `AtencionHumanaService`.
   */
  @Post(':id/atencion/tomar')
  tomarAtencion(@Param('id') id: string, @CurrentUser() usuario: UsuarioJwt) {
    return this.atencion.tomar(id, usuario.sub, alcanceAgente(usuario));
  }

  @Post(':id/atencion/liberar')
  liberarAtencion(@Param('id') id: string, @CurrentUser() usuario: UsuarioJwt) {
    return this.atencion.liberar(id, usuario.sub, tieneAlcanceGlobal(usuario.rol), alcanceAgente(usuario));
  }

  @Post(':id/atencion/resolver')
  resolverAtencion(@Param('id') id: string, @CurrentUser() usuario: UsuarioJwt) {
    return this.atencion.resolver(id, usuario.sub, alcanceAgente(usuario));
  }

  /**
   * El pago de una promoción por WhatsApp (docs/pagos-promocion.md). Lo ve quien
   * puede ver el chat; confirmar registra una venta y exige rango de agente (lo
   * comprueba el servicio).
   */
  @Post(':id/pagos/:pagoId/confirmar')
  confirmarPago(@Param('id') id: string, @Param('pagoId', ParseUUIDPipe) pagoId: string, @CurrentUser() usuario: UsuarioJwt) {
    return this.promocionesChat.confirmar(id, pagoId, usuario, alcanceAgente(usuario));
  }

  @Post(':id/pagos/:pagoId/pedir-otro')
  pedirOtroComprobante(
    @Param('id') id: string,
    @Param('pagoId', ParseUUIDPipe) pagoId: string,
    @Body() dto: PedirOtroComprobanteDto,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    return this.promocionesChat.pedirOtroComprobante(id, pagoId, dto.motivo, usuario, alcanceAgente(usuario));
  }

  @Post(':id/pagos/:pagoId/anular')
  anularPago(@Param('id') id: string, @Param('pagoId', ParseUUIDPipe) pagoId: string, @CurrentUser() usuario: UsuarioJwt) {
    return this.promocionesChat.anular(id, pagoId, usuario, alcanceAgente(usuario));
  }

  @Post(':id/automatizacion/reanudar')
  reanudarAutomatizacion(@Param('id') id: string, @CurrentUser() usuario: UsuarioJwt) {
    return this.atencion.reanudarAutomatizacion(id, usuario.sub, alcanceAgente(usuario));
  }

  @Post(':id/reabrir')
  reabrir(@Param('id') id: string, @CurrentUser() usuario: UsuarioJwt) {
    return this.conversacionesService.reabrir(id, alcanceAgente(usuario));
  }

  /** Enviar una plantilla aprobada al paciente de esta conversación. */
  @Post(':id/plantilla')
  enviarPlantilla(
    @Param('id') id: string,
    @Body() dto: EnviarPlantillaDto,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    const soloAgenteId = alcanceAgente(usuario);
    return this.plantillas.enviarPlantilla(id, dto, usuario.sub, soloAgenteId);
  }

  /** Asignar agente a conversación — solo ADMIN. */
  @Patch(':id/agente')
  @Roles('ADMIN')
  asignarAgente(
    @Param('id') id: string,
    @Body() dto: AsignarAgenteDto,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    /* El actor queda registrado en la auditoría de esta conversación. */
    return this.conversacionesService.asignarAgente(id, dto.agenteId, usuario.sub);
  }
}
