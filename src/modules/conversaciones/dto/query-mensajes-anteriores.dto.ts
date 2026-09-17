import { Type } from 'class-transformer';
import { IsISO8601, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

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

  /**
   * Id de ese mismo mensaje, para desempatar. Opcional a propósito.
   *
   * `createdAt` NO es único: la columna es `TIMESTAMP(3) DEFAULT
   * CURRENT_TIMESTAMP` y en PostgreSQL eso es la hora de INICIO DE TRANSACCIÓN,
   * así que todos los mensajes que la ingesta persiste en una misma transacción
   * comparten el valor exacto. Con solo la fecha, una página que cortara dentro
   * de un grupo empatado se saltaba al resto para siempre.
   *
   * Es opcional para no romper a un cliente antiguo que solo mande la fecha:
   * sin él se conserva el comportamiento anterior, que sigue siendo correcto
   * mientras no haya empates en la frontera.
   */
  @IsOptional()
  @IsUUID()
  antesDeId?: string;

  /** Cuántos traer. El tope duro también está en el service, por si acaso. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
