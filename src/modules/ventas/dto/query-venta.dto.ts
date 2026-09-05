import { EstadoVenta } from '../../../prisma/prisma-client';
import { IsDateString, IsEnum, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

import { PaginationDto } from '../../../common/dto/pagination.dto';

/**
 * Filtro de comprobante. Es un enum y no una cadena libre porque los dos
 * valores son ramas de `where` distintas: cualquier otra cosa —un `TODOS` que
 * se coló, una errata— caía al `else` y devolvía la lista **entera** sin decir
 * nada, que en una pantalla llamada "Pendientes de comprobante" se lee como un
 * dato ("están todas pendientes") y no como el error que es.
 */
export const FILTROS_COMPROBANTE = ['CON_COMPROBANTE', 'SIN_COMPROBANTE'] as const;
export type FiltroComprobante = (typeof FILTROS_COMPROBANTE)[number];

export class QueryVentaDto extends PaginationDto {
  /** Búsqueda libre por paciente, teléfono, CI, PAC, producto, médico o comprobante. */
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsEnum(EstadoVenta)
  estado?: EstadoVenta;

  @IsOptional()
  @IsString()
  agenteId?: string;

  @IsOptional()
  @IsDateString()
  desde?: string;

  @IsOptional()
  @IsDateString()
  hasta?: string;

  /**
   * Método de pago exacto. Cadena y no enum porque la columna es
   * `VarChar(50)` y arrastra valores de importaciones antiguas que la interfaz
   * ya no ofrece; un `@IsEnum` con las cuatro opciones de hoy haría imposible
   * filtrar por ellos. El largo sí se acota al de la columna.
   *
   * **La ausencia de filtro se expresa omitiendo el parámetro**, no mandando un
   * `TODOS`: ese centinela es de la interfaz y se queda en la interfaz.
   */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  metodoPago?: string;

  @IsOptional()
  @IsIn(FILTROS_COMPROBANTE)
  comprobante?: FiltroComprobante;
}
