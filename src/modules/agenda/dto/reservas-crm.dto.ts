import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { FECHA_AGENDA } from '../agenda.contrato';
import { ESTADOS_RESERVA_AGENDA, EstadoReservaAgenda } from '../agenda-consulta.sql';

/** Filtros de la pantalla Reservas. «Todas» se pide omitiendo `estado`. */
export class QueryReservasAgendaDto extends PaginationDto {
  @IsOptional() @IsString() @Matches(FECHA_AGENDA)
  desde?: string;

  @IsOptional() @IsString() @Matches(FECHA_AGENDA)
  hasta?: string;

  @IsOptional() @IsIn(ESTADOS_RESERVA_AGENDA)
  estado?: EstadoReservaAgenda;

  @IsOptional() @IsString() @MaxLength(60)
  buscar?: string;
}
