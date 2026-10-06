import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
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
import { DirectorioService } from './directorio.service';
import { ActualizarEspecialidadDto, CrearEspecialidadDto, QueryEspecialidadesDto } from './dto/especialidad.dto';
import {
  ActualizarPerfilMedicoDto,
  CrearAusenciaDto,
  CrearPerfilMedicoDto,
  GuardarHorarioDto,
  PublicarPerfilDto,
  QueryMedicosSinFichaDto,
  QueryPerfilesMedicosDto,
} from './dto/perfil-medico.dto';

/**
 * El directorio médico desde el CRM. Leerlo: cualquier sesión (recepción
 * contesta «¿qué días atiende la doctora?»). Escribirlo: administración (ADMIN).
 */
@Controller('directorio')
export class DirectorioController {
  constructor(private readonly service: DirectorioService) {}

  /* ── Especialidades ── */

  @Get('especialidades')
  @Roles('RECEPCION')
  especialidades(@Query() query: QueryEspecialidadesDto) {
    return this.service.listarEspecialidades(query);
  }

  @Post('especialidades')
  @Roles('ADMIN')
  crearEspecialidad(@Body() dto: CrearEspecialidadDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.service.crearEspecialidad(dto, usuario.sub);
  }

  @Patch('especialidades/:id')
  @Roles('ADMIN')
  actualizarEspecialidad(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ActualizarEspecialidadDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.service.actualizarEspecialidad(id, dto, usuario.sub);
  }

  /* ── Fichas de médicos ── */

  /** Declarada antes de `medicos/:id`: Express casa en orden. */
  @Get('medicos/sin-ficha')
  @Roles('ADMIN')
  medicosSinFicha(@Query() query: QueryMedicosSinFichaDto) {
    return this.service.medicosSinFicha(query);
  }

  @Get('medicos')
  @Roles('RECEPCION')
  fichas(@Query() query: QueryPerfilesMedicosDto) {
    return this.service.listarFichas(query);
  }

  @Get('medicos/:id')
  @Roles('RECEPCION')
  ficha(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.obtenerFicha(id);
  }

  @Post('medicos')
  @Roles('ADMIN')
  crearFicha(@Body() dto: CrearPerfilMedicoDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.service.crearFicha(dto, usuario.sub);
  }

  @Patch('medicos/:id')
  @Roles('ADMIN')
  actualizarFicha(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ActualizarPerfilMedicoDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.service.actualizarFicha(id, dto, usuario.sub);
  }

  @Put('medicos/:id/horario')
  @Roles('ADMIN')
  guardarHorario(@Param('id', ParseUUIDPipe) id: string, @Body() dto: GuardarHorarioDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.service.guardarHorario(id, dto, usuario.sub);
  }

  @Post('medicos/:id/ausencias')
  @Roles('ADMIN')
  agregarAusencia(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CrearAusenciaDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.service.agregarAusencia(id, dto, usuario.sub);
  }

  @Delete('medicos/:id/ausencias/:ausenciaId')
  @Roles('ADMIN')
  @HttpCode(204)
  quitarAusencia(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('ausenciaId', ParseUUIDPipe) ausenciaId: string,
    @CurrentUser() usuario: UsuarioJwt,
  ) {
    return this.service.quitarAusencia(id, ausenciaId, usuario.sub);
  }

  @Put('medicos/:id/publicacion')
  @Roles('ADMIN')
  publicar(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PublicarPerfilDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.service.publicar(id, dto.publicado, usuario.sub);
  }

  /** `limits`: multer corta al pasar el tope en vez de leer el archivo entero a memoria. */
  @Post('medicos/:id/foto')
  @Roles('ADMIN')
  @UseInterceptors(FileInterceptor('archivo', { limits: { fileSize: BYTES_MAXIMOS_IMAGEN, files: 1 } }))
  subirFoto(@Param('id', ParseUUIDPipe) id: string, @UploadedFile() archivo: ArchivoSubido | undefined, @CurrentUser() usuario: UsuarioJwt) {
    return this.service.subirFoto(id, archivo, usuario.sub);
  }

  @Delete('medicos/:id/foto')
  @Roles('ADMIN')
  quitarFoto(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() usuario: UsuarioJwt) {
    return this.service.quitarFoto(id, usuario.sub);
  }
}
