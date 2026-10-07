import { Controller, Get, Header, Query } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { AgendaService } from './agenda.service';
import { QueryDisponibilidadAgendaDto, QueryMedicosAgendaDto } from './dto/query-agenda.dto';

@Public()
@Controller('publico/agenda')
export class AgendaPublicaController {
  constructor(private readonly agenda: AgendaService) {}

  @Get('especialidades')
  @Header('Cache-Control', 'no-store')
  especialidades(@Query() query: PaginationDto) { return this.agenda.especialidades(query); }

  @Get('medicos')
  @Header('Cache-Control', 'no-store')
  medicos(@Query() query: QueryMedicosAgendaDto) { return this.agenda.medicos(query); }

  @Get('disponibilidad')
  @Header('Cache-Control', 'no-store')
  disponibilidad(@Query() query: QueryDisponibilidadAgendaDto) { return this.agenda.disponibilidad(query); }
}
