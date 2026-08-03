import { IsISO8601, IsOptional, IsString, Length } from 'class-validator';

import { PaginationDto } from '../../../common/dto/pagination.dto';

/** Filtros del dashboard de servicios. */
export class QueryServiciosDto {
  /** Acota a un mes ya importado. Sin él, el dashboard mira todo el historial. */
  @IsOptional()
  @IsString()
  periodoId?: string;

  /** `LABORATORIO`, `CONSULTA`, `PLANES`, `INTERNACION`… tal como viene del Excel. */
  @IsOptional()
  @IsString()
  @Length(1, 40)
  modulo?: string;

  @IsOptional()
  @IsISO8601()
  desde?: string;

  @IsOptional()
  @IsISO8601()
  hasta?: string;
}

/** Listado de pacientes con servicios. */
export class QueryPacientesDto extends PaginationDto {
  /** Cruza contra el nombre y el código del paciente. */
  @IsOptional()
  @IsString()
  @Length(1, 120)
  busqueda?: string;
}

/** Listado de médicos. */
export class QueryMedicosDto extends PaginationDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  busqueda?: string;
}
