import { EstadoVenta } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** DTO para cambio de estado de venta (solo ADMIN). */
export class CambiarEstadoDto {
  @IsEnum(EstadoVenta)
  estado!: EstadoVenta;

  /**
   * Obligatorio en el service cuando `estado = PERDIDA`. Mismo criterio que
   * `Lead.motivoPerdida` y `VentaImportada.motivoExclusion`: mover dinero —o
   * dejar de moverlo— sin decir por qué es irrecuperable a los tres meses.
   */
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  motivoPerdida?: string;
}
