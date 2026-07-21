import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/** Tope duro: ninguna petición puede pedir más de esto de una sola vez. */
export const LIMITE_MAXIMO = 100;
export const LIMITE_POR_DEFECTO = 25;

/**
 * Paginación estándar de todos los listados.
 * Heredar de aquí en los DTO de query de cada dominio:
 *   `export class QueryClienteDto extends PaginationDto { … }`
 */
export class PaginationDto {
  /** Página solicitada, empezando en 1. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pagina?: number;

  /** Elementos por página (máximo 100). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(LIMITE_MAXIMO)
  limite?: number;
}

/** Sobre de respuesta de todo listado paginado. */
export interface RespuestaPaginada<T> {
  datos: T[];
  total: number;
  pagina: number;
  limite: number;
  totalPaginas: number;
}

/** Traduce `{pagina, limite}` a los `skip`/`take` que entiende Prisma. */
export function calcularPaginacion(dto: PaginationDto): { skip: number; take: number } {
  const pagina = Math.max(1, dto.pagina ?? 1);
  const limite = Math.min(LIMITE_MAXIMO, Math.max(1, dto.limite ?? LIMITE_POR_DEFECTO));
  return { skip: (pagina - 1) * limite, take: limite };
}

/** Arma el sobre de respuesta a partir de los registros y el total real de la tabla. */
export function paginar<T>(
  datos: T[],
  total: number,
  dto: PaginationDto,
): RespuestaPaginada<T> {
  const { take } = calcularPaginacion(dto);
  return {
    datos,
    total,
    pagina: Math.max(1, dto.pagina ?? 1),
    limite: take,
    totalPaginas: Math.max(1, Math.ceil(total / take)),
  };
}
