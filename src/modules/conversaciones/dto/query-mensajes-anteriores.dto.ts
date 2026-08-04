import { Type } from 'class-transformer';
import { IsISO8601, IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Cursor del scroll hacia arriba del chat: trae los mensajes anteriores a
 * `antesDe`.
 *
 * Existe porque los dos parámetros llegaban como `@Query` crudo sin validar:
 * `new Date(antesDe)` con un valor ausente o basura daba `Invalid Date`, que
 * Prisma rechaza con un 500. Una fecha mal escrita en la URL no es un error del
 * servidor, es un 400.
 */
export class QueryMensajesAnterioresDto {
  /** Marca de tiempo ISO del mensaje más antiguo que ya tiene el cliente. */
  @IsISO8601()
  antesDe!: string;

  /** Cuántos traer. El tope duro también está en el service, por si acaso. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
