import { EstadoVenta } from '@prisma/client';
import { IsEnum } from 'class-validator';

/** DTO para cambio de estado de venta (solo ADMIN). */
export class CambiarEstadoDto {
  @IsEnum(EstadoVenta)
  estado!: EstadoVenta;
}
