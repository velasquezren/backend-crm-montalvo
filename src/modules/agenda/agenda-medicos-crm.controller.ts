import { Body, Controller, Get, Header, Param, ParseIntPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { CurrentUser, UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { AgendaMedicosCrmService } from './agenda-medicos-crm.service';
import {
  ActualizarMedicoAgendaDto,
  CrearMedicoAgendaDto,
  GuardarHorarioAgendaDto,
  QueryMedicosAgendaAdminDto,
  RenombrarEspecialidadAgendaDto,
} from './dto/medicos-agenda.dto';

/**
 * Médicos, horarios y especialidades de la agenda de la clínica, desde el
 * Directorio del CRM. Cualquier rol entra a la ruta; quién ve y quién edita lo
 * decide el servicio (`puedeVerAgendaClinica` / `puedeEditarAgendaClinica`).
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
  especialidades(@Query() query: PaginationDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.medicos.especialidades(query, usuario);
  }

  @Post('especialidades/renombrar')
  renombrarEspecialidad(@Body() dto: RenombrarEspecialidadAgendaDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.medicos.renombrarEspecialidad(dto, usuario);
  }

  @Get('bancos')
  @Header('Cache-Control', 'private, no-store')
  bancos(@CurrentUser() usuario: UsuarioJwt) {
    return this.medicos.bancos(usuario);
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
}
