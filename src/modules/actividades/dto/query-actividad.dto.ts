import { EstadoActividad, TipoActividad } from '../../../prisma/prisma-client';
import { Type } from 'class-transformer';
import { IsDate, IsEnum, IsOptional, IsString } from 'class-validator';

import { PaginationDto } from '../../../common/dto/pagination.dto';

export class QueryActividadDto extends PaginationDto {
  @IsOptional()
  @IsEnum(TipoActividad)
  tipo?: TipoActividad;

  @IsOptional()
  @IsEnum(EstadoActividad)
  estado?: EstadoActividad;

  @IsOptional()
  @IsString()
  clienteId?: string;

  @IsOptional()
  @IsString()
  leadId?: string;

  /** Solo tiene efecto para ADMIN+: un AGENTE siempre queda acotado a lo suyo. */
  @IsOptional()
  @IsString()
  agenteId?: string;

  /** Búsqueda libre: título, notas o nombre del cliente. */
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  desde?: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  hasta?: Date;
}
