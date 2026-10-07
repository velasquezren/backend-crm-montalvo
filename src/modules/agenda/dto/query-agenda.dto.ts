import { IsString, Matches } from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { FECHA_AGENDA, ID_AGENDA } from '../agenda.contrato';

export class QueryMedicosAgendaDto extends PaginationDto {
  @IsString()
  @Matches(ID_AGENDA)
  especialidadId!: string;
}

export class QueryDisponibilidadAgendaDto {
  @IsString()
  @Matches(ID_AGENDA)
  medicoId!: string;

  @IsString()
  @Matches(FECHA_AGENDA)
  fecha!: string;
}

export class QueryDiasAgendaDto {
  @IsString()
  @Matches(/^\d{1,10}$/)
  medicoId!: string;
}
