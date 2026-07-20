import { EstadoComision } from '@prisma/client';
import { IsDateString, IsEnum, IsOptional, IsString } from 'class-validator';

/** RF-14 — consultar comisiones por agente y periodo. */
export class QueryComisionDto {
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
