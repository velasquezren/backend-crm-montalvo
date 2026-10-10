import { Body, Controller, Delete, Get, Header, Param, ParseIntPipe, Put } from '@nestjs/common';

import { CurrentUser, UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AccesoMedicoAgendaService } from './acceso-medico-agenda.service';
import { AutorizarTelefonoMedicoDto } from './dto/acceso-medico.dto';

/**
 * El número de WhatsApp con el que un médico consulta su agenda por el asistente.
 * Solo administración: el servicio lo vuelve a exigir, que el rol del decorador
 * es el suelo y no la regla.
 */
@Roles('ADMIN')
@Controller('agenda/medicos/:id/whatsapp')
export class AccesoMedicoAgendaController {
  constructor(private readonly acceso: AccesoMedicoAgendaService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  async ver(@Param('id', ParseIntPipe) id: number, @CurrentUser() usuario: UsuarioJwt) {
    return { acceso: await this.acceso.deMedico(id, usuario) };
  }

  @Put()
  autorizar(@Param('id', ParseIntPipe) id: number, @Body() dto: AutorizarTelefonoMedicoDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.acceso.autorizar(id, dto.telefono, usuario);
  }

  @Delete()
  revocar(@Param('id', ParseIntPipe) id: number, @CurrentUser() usuario: UsuarioJwt) {
    return this.acceso.revocar(id, usuario);
  }
}
