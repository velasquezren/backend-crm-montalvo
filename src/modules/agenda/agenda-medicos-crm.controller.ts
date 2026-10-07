import { Body, Controller, Delete, Get, Header, Param, ParseIntPipe, Patch, Post, Put, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ArchivoSubido } from '../../common/archivos/archivo-subido';
import { CurrentUser, UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { BYTES_MAXIMOS_IMAGEN } from '../../common/storage/imagen-publica';
import { AgendaMedicosCrmService } from './agenda-medicos-crm.service';
import {
  ActualizarMedicoAgendaDto,
  ActualizarPresentacionAgendaDto,
  CrearMedicoAgendaDto,
  GuardarHorarioAgendaDto,
  PublicarPresentacionAgendaDto,
  QueryMedicosAgendaAdminDto,
  RenombrarEspecialidadAgendaDto,
} from './dto/medicos-agenda.dto';

/**
 * Médicos, horarios y especialidades de la agenda de la clínica, desde el
 * Directorio del CRM. Cualquier sesión los ve (sin el teléfono del médico si
 * no gestiona citas); quién edita lo decide el servicio (`puedeEditarAgendaClinica`).
 * Las rutas fijas van antes de `:id`.
 */
@Roles('RECEPCION')
@Controller('agenda/medicos')
export class AgendaMedicosCrmController {
  constructor(private readonly medicos: AgendaMedicosCrmService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  listar(@Query() query: QueryMedicosAgendaAdminDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.medicos.listar(query, usuario);
  }

  @Post()
  crear(@Body() dto: CrearMedicoAgendaDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.medicos.crear(dto, usuario);
  }

  @Get('especialidades')
  @Header('Cache-Control', 'private, no-store')
  especialidades(@Query() query: PaginationDto) {
    return this.medicos.especialidades(query);
  }

  @Post('especialidades/renombrar')
  renombrarEspecialidad(@Body() dto: RenombrarEspecialidadAgendaDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.medicos.renombrarEspecialidad(dto, usuario);
  }

  @Get('bancos')
  @Header('Cache-Control', 'private, no-store')
  bancos() {
    return this.medicos.bancos();
  }

  @Get(':id')
  @Header('Cache-Control', 'private, no-store')
  ficha(@Param('id', ParseIntPipe) id: number, @CurrentUser() usuario: UsuarioJwt) {
    return this.medicos.ficha(id, usuario);
  }

  @Patch(':id')
  actualizar(@Param('id', ParseIntPipe) id: number, @Body() dto: ActualizarMedicoAgendaDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.medicos.actualizar(id, dto, usuario);
  }

  @Put(':id/horario')
  guardarHorario(@Param('id', ParseIntPipe) id: number, @Body() dto: GuardarHorarioAgendaDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.medicos.guardarHorario(id, dto, usuario);
  }

  /* ── Presentación web: foto, biografía y publicación ── */

  @Post(':id/presentacion')
  crearPresentacion(@Param('id', ParseIntPipe) id: number, @CurrentUser() usuario: UsuarioJwt) {
    return this.medicos.crearPresentacion(id, usuario);
  }

  @Patch(':id/presentacion')
  actualizarPresentacion(@Param('id', ParseIntPipe) id: number, @Body() dto: ActualizarPresentacionAgendaDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.medicos.actualizarPresentacion(id, dto, usuario);
  }

  @Put(':id/presentacion/publicacion')
  publicarPresentacion(@Param('id', ParseIntPipe) id: number, @Body() dto: PublicarPresentacionAgendaDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.medicos.publicarPresentacion(id, dto.publicado, usuario);
  }

  /** `limits`: multer corta al pasar el tope en vez de leer el archivo entero a memoria. */
  @Post(':id/presentacion/foto')
  @UseInterceptors(FileInterceptor('archivo', { limits: { fileSize: BYTES_MAXIMOS_IMAGEN, files: 1 } }))
  subirFoto(@Param('id', ParseIntPipe) id: number, @UploadedFile() archivo: ArchivoSubido | undefined, @CurrentUser() usuario: UsuarioJwt) {
    return this.medicos.subirFoto(id, archivo, usuario);
  }

  @Delete(':id/presentacion/foto')
  quitarFoto(@Param('id', ParseIntPipe) id: number, @CurrentUser() usuario: UsuarioJwt) {
    return this.medicos.quitarFoto(id, usuario);
  }
}
