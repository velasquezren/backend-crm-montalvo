import { Controller, Get, Header, Param, ParseIntPipe, Query } from '@nestjs/common';
import { CurrentUser, UsuarioJwt } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AgendaReservasCrmService } from './agenda-reservas-crm.service';
import { QueryReservasAgendaDto } from './dto/reservas-crm.dto';

/**
 * Las reservas de la agenda de la clínica dentro del CRM (con sesión: aquí hay
 * datos de pacientes). Cualquier rol entra a la ruta; qué ve cada uno lo decide
 * el servicio (`puedeVerAgendaClinica` o el acceso al chat). Nada se guarda en
 * cachés intermedias.
 */
@Roles('RECEPCION')
@Controller('agenda/reservas')
export class AgendaReservasCrmController {
  constructor(private readonly reservas: AgendaReservasCrmService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  listar(@Query() query: QueryReservasAgendaDto, @CurrentUser() usuario: UsuarioJwt) {
    return this.reservas.listar(query, usuario);
  }

  @Get('conversacion/:id')
  @Header('Cache-Control', 'private, no-store')
  deConversacion(@Param('id') id: string, @CurrentUser() usuario: UsuarioJwt) {
    return this.reservas.deConversacion(id, usuario);
  }

  @Get(':id/comprobante')
  @Header('Cache-Control', 'private, no-store')
  comprobante(@Param('id', ParseIntPipe) id: number, @CurrentUser() usuario: UsuarioJwt) {
    return this.reservas.comprobante(id, usuario);
  }
}
