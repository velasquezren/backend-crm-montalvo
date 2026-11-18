import { Matches } from 'class-validator';

import { PaginationDto } from '../../../common/dto/pagination.dto';

/**
 * Un mes de la constancia de entregas de resultados, en el calendario de la
 * clínica (La Paz). Paginada como todo listado: la pantalla de impresión pide
 * las páginas hasta tenerlas todas y solo entonces deja imprimir.
 */
export class QueryConstanciaDto extends PaginationDto {
  /** `2026-11`. */
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'mes debe tener la forma AAAA-MM' })
  mes!: string;
}
