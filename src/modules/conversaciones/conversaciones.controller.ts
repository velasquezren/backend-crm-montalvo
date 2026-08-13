import { Body, Controller, Get, NotFoundException, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { alcanceAgente } from '../../common/auth/roles';
import { CurrentUser, UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { R2Service } from '../../common/storage/r2.service';
import { ConversacionesService } from './conversaciones.service';
import { AsignarAgenteDto } from './dto/asignar-agente.dto';
import { EnviarMensajeDto } from './dto/enviar-mensaje.dto';
import { EnviarPlantillaDto } from './dto/enviar-plantilla.dto';
import { DescargarMediaDto } from './dto/descargar-media.dto';
import { MarcarLeidoDto } from './dto/marcar-leido.dto';
import { QueryConversacionesDto } from './dto/query-conversaciones.dto';
import { QueryMensajesAnterioresDto } from './dto/query-mensajes-anteriores.dto';

@Controller('conversaciones')
export class ConversacionesController {
  constructor(
    private readonly conversacionesService: ConversacionesService,
    private readonly r2: R2Service,
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
    return this.conversacionesService.findAll(
      alcanceAgente(usuario),
      query.soloMios ? usuario.sub : undefined,
    );
  }

  /**
   * Proxy de descarga de media almacenada en R2.
   *
   * El navegador NO puede hacer `fetch` ni `<a download>` a las URLs firmadas
   * de Cloudflare R2 porque R2 no incluye cabeceras CORS (`Access-Control-
   * Allow-Origin`) en las respuestas a presigned URLs. La descarga se resuelve
   * aquí servidor ↔ servidor (sin restricciones de origen) y se reenvía al
   * navegador con `Content-Disposition: attachment` para forzar el guardado
   * del archivo.
   *
   * IMPORTANTE: va ANTES de `@Get(':id')` para que NestJS no lo confunda con
   * un parámetro de ruta `:id`.
   */
  @Get('media/descargar')
  async descargarMedia(
    @Query() query: DescargarMediaDto,
    @CurrentUser() usuario: UsuarioJwt,
    @Res() res: Response,
  ): Promise<void> {
    const { key } = query;

    /* La clave sola no autoriza nada: tiene que pertenecer a un mensaje de una
       conversación que este usuario pueda ver. 404 y no 403, igual que en
       `findOne`, para no confirmar que el archivo existe. */
    if (!(await this.conversacionesService.puedeDescargarMedia(key, alcanceAgente(usuario)))) {
      throw new NotFoundException('Archivo no encontrado');
    }

    const archivo = await this.r2.descargar(key);
    if (!archivo) throw new NotFoundException('Archivo no encontrado en R2');

    const nombre = key.substring(key.lastIndexOf('/') + 1) || 'archivo';
    res.set({
      'Content-Type': archivo.contentType,
      'Content-Disposition': `attachment; filename="${nombre}"`,
      'Content-Length': String(archivo.buffer.byteLength),
      'Cache-Control': 'private, max-age=300',
    });
    res.end(Buffer.from(archivo.buffer));
  }

  /** Plantillas aprobadas de la WABA — para el selector al escribir fuera de la ventana de 24h. */
  @Get('meta/plantillas')
  listarPlantillas(@Query('refresh') refresh?: string) {
    return this.conversacionesService.listarPlantillas(refresh === 'true');
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
