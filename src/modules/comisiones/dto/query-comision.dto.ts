import { EstadoComision } from '@prisma/client';
import { IsDateString, IsEnum, IsOptional, IsString } from 'class-validator';

import { PaginationDto } from '../../../common/dto/pagination.dto';

/** RF-14 — consultar comisiones por agente y periodo. */
export class QueryComisionDto extends PaginationDto {
  @IsOptional()
  @IsEnum(EstadoComision)
  estado?: EstadoComision;

  @IsOptional()
  @IsString()
  agenteId?: string;

  @IsOptional()
  @IsDateString()
  desde?: string;

  @IsOptional()
  @IsDateString()
  hasta?: string;
}
