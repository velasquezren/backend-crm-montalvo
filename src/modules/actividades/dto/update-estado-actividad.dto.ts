import { EstadoActividad } from '../../../prisma/prisma-client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateEstadoActividadDto {
  @IsEnum(EstadoActividad)
  estado!: EstadoActividad;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notas?: string;
}
