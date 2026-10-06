import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import { ArchivoSubido } from '../../common/archivos/archivo-subido';
import { CurrentUser, UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { BYTES_MAXIMOS_IMAGEN } from '../../common/storage/imagen-publica';
import { FormatoBanner } from '../../prisma/prisma-client';
import {
  ActualizarPromocionDto,
  CrearPromocionDto,
  DevolverPromocionDto,
  QueryAnunciosSinPromocionDto,
  QueryPromocionesDto,
  SubirBannerDto,
} from './dto/promocion.dto';
import { PromocionesService } from './promociones.service';
import { ParseAnuncioIdPipe } from './parse-anuncio-id.pipe';

/**
 * Promociones desde el CRM. Verlas: cualquier sesión (recepción las ofrece).
 * Redactarlas y subir banners: agentes. Publicar, devolver, pausar y archivar:
 * ADMIN. El service vuelve a exigir el permiso según el ESTADO de cada una.
 */
@Controller('promociones')
export class PromocionesController {
  constructor(private readonly service: PromocionesService) {}

  @Get()
  @Roles('RECEPCION')
  listar(@Query() query: QueryPromocionesDto) {
    return this.service.listar(query);
  }

  /* Las rutas fijas van antes de `:id`: Express casa en orden. */

  @Get('anuncios/sin-promocion')
  @Roles('AGENTE')
  anunciosSinPromocion(@Query() query: QueryAnunciosSinPromocionDto) {
    return this.service.anunciosSinPromocion(query);
  }

  @Get('atribucion/:anuncioId')
  @Roles('RECEPCION')
  atribucion(@Param('anuncioId', ParseAnuncioIdPipe) anuncioId: string) {
    return this.service.atribucion(anuncioId);
  }

  @Get(':id')
  @Roles('RECEPCION')
  obtener(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() usuario: UsuarioJwt) {
    return this.service.obtener(id, usuario);
  }

  @Post()
  @Roles('AGENTE')
  crear(@Body() dto: CrearPromocionDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.service.crear(dto, usuario);
  }

  @Patch(':id')
  @Roles('AGENTE')
  actualizar(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ActualizarPromocionDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.service.actualizar(id, dto, usuario);
  }

  /* ── Ciclo de vida ── */

  @Post(':id/enviar')
  @Roles('AGENTE')
  enviar(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() usuario: UsuarioJwt) {
    return this.service.transicion(id, 'enviar', usuario);
  }

  @Post(':id/devolver')
  @Roles('ADMIN')
  devolver(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DevolverPromocionDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.service.transicion(id, 'devolver', usuario, dto.motivo);
  }

  @Post(':id/publicar')
  @Roles('ADMIN')
  publicar(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() usuario: UsuarioJwt) {
    return this.service.transicion(id, 'publicar', usuario);
  }

  @Post(':id/pausar')
  @Roles('ADMIN')
  pausar(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() usuario: UsuarioJwt) {
    return this.service.transicion(id, 'pausar', usuario);
  }

  @Post(':id/archivar')
  @Roles('ADMIN')
  archivar(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() usuario: UsuarioJwt) {
    return this.service.transicion(id, 'archivar', usuario);
  }

  /* ── Banners ── */

  /** `limits`: multer corta al pasar el tope en vez de leer el archivo entero a memoria. */
  @Put(':id/banners/:formato')
  @Roles('AGENTE')
  @UseInterceptors(FileInterceptor('archivo', { limits: { fileSize: BYTES_MAXIMOS_IMAGEN, files: 1 } }))
  subirBanner(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('formato', new ParseEnumPipe(FormatoBanner)) formato: FormatoBanner,
    @UploadedFile() archivo: ArchivoSubido | undefined,
    @Body() dto: SubirBannerDto,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    return this.service.subirBanner(id, formato, archivo, dto.textoAlternativo, usuario);
  }

  @Delete(':id/banners/:formato')
  @Roles('AGENTE')
  quitarBanner(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('formato', new ParseEnumPipe(FormatoBanner)) formato: FormatoBanner,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    return this.service.quitarBanner(id, formato, usuario);
  }

  /* ── Anuncios de Meta ── */

  @Put(':id/anuncios/:anuncioId')
  @Roles('AGENTE')
  asignarAnuncio(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('anuncioId', ParseAnuncioIdPipe) anuncioId: string,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    return this.service.asignarAnuncio(id, anuncioId, usuario);
  }

  @Delete(':id/anuncios/:anuncioId')
  @Roles('AGENTE')
  quitarAnuncio(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('anuncioId', ParseAnuncioIdPipe) anuncioId: string,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    return this.service.quitarAnuncio(id, anuncioId, usuario);
  }
}

