import { OrigenLead } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MinLength } from 'class-validator';

/** RF-23: registra consultas de clientes que no derivan en venta. */
export class CreateInteresDto {
  @IsString()
  @MinLength(2)
  descripcion!: string;

  @IsOptional()
  @IsString()
  categoriaProducto?: string;

  @IsEnum(OrigenLead)
  origen!: OrigenLead;

  @IsOptional()
  @IsString()
  agenteId?: string;
}
