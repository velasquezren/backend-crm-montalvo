import { EstadoVenta } from '@prisma/client';
import { IsDateString, IsEnum, IsOptional, IsString } from 'class-validator';

import { PaginationDto } from '../../../common/dto/pagination.dto';

export class QueryVentaDto extends PaginationDto {
  /** Búsqueda libre por paciente, teléfono, CI, producto, médico o comprobante. */
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsEnum(EstadoVenta)
  estado?: EstadoVenta;

  @IsOptional()
  @IsString()
  agenteId?: string;

  @IsOptional()
  @IsDateString()
  desde?: string;

  @IsOptional()
  @IsDateString()
  hasta?: string;

  @IsOptional()
  @IsString()
  metodoPago?: string;

  @IsOptional()
  @IsString()
  comprobante?: string;
}
