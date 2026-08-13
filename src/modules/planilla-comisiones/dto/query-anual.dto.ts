import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Año que se quiere ver en el resumen anual.
 *
 * El tope inferior descarta un `?anio=0` que devolvería doce meses vacíos, y el
 * superior evita consultar años que no pueden existir todavía. Sin el DTO
 * llegaría como texto crudo y `new Date()` con basura revienta en Prisma con un
 * 500 — que no es lo que corresponde a un parámetro mal escrito en la URL.
 */
export class QueryAnualDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2020)
  @Max(2100)
  anio?: number;
}
