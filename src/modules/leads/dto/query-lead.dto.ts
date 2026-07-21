import { EstadoLead, OrigenLead } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsString } from 'class-validator';

import { PaginationDto } from '../../../common/dto/pagination.dto';

export class QueryLeadDto extends PaginationDto {
  @IsOptional()
  @IsEnum(OrigenLead)
  origen?: OrigenLead;

  @IsOptional()
  @IsEnum(EstadoLead)
  estado?: EstadoLead;

  @IsOptional()
  @IsString()
  agenteId?: string;

  /**
   * Los leads con origen IMPORTACION son el histórico cargado desde FileMaker
   * (15.000+ pacientes antiguos): no son prospectos que un agente deba trabajar,
   * así que por defecto quedan FUERA del pipeline. Se piden explícitamente con
   * `incluirImportacion=true` para consultar el archivo histórico.
   */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  incluirImportacion?: boolean;
}
