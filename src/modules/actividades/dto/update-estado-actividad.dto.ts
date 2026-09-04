import { EstadoActividad } from '@prisma/client';
import { IsEnum } from 'class-validator';

export class UpdateEstadoActividadDto {
  @IsEnum(EstadoActividad)
  estado!: EstadoActividad;
}
