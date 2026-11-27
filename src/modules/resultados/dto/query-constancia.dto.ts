import { IsIn, IsOptional, Matches } from 'class-validator';

import { PaginationDto } from '../../../common/dto/pagination.dto';

/** `VALIDADA` = la copia congelada al validar el mes; `EN_VIVO` = recalculada ahora. */
export const VERSIONES_CONSTANCIA = ['VALIDADA', 'EN_VIVO'] as const;
export type VersionConstancia = (typeof VERSIONES_CONSTANCIA)[number];

export const PATRON_MES = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Un mes de la constancia de entregas de resultados, en el calendario de la
 * clínica (La Paz). Paginada como todo listado: la pantalla de impresión pide
 * las páginas hasta tenerlas todas y solo entonces deja imprimir.
 */
export class QueryConstanciaDto extends PaginationDto {
  /** `2026-11`. */
  @Matches(PATRON_MES, { message: 'mes debe tener la forma AAAA-MM' })
  mes!: string;

  /**
   * Sin indicar: la copia validada si el mes está validado, si no en vivo.
   * `EN_VIVO` en un mes validado recalcula (para comparar), sin tocar la copia.
   */
  @IsOptional()
  @IsIn(VERSIONES_CONSTANCIA)
  version?: VersionConstancia;
}
