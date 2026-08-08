import { CategoriaCliente } from '@prisma/client';
import { IsEnum, IsIn, IsOptional, IsString } from 'class-validator';

import {
  DIRECCIONES_ORDEN,
  DireccionOrden,
  PaginationDto,
} from '../../../common/dto/pagination.dto';

/**
 * Columnas por las que se puede ordenar el listado.
 *
 * Lista cerrada y **solo con columnas indexadas** (ver `schema.prisma`): con
 * 15.000+ fichas, ordenar por una columna sin índice obliga a Postgres a
 * ordenarlas todas en cada página. Añadir una aquí sin su `@@index` es meter
 * lentitud que no se nota en desarrollo con veinte filas.
 */
export const ORDEN_CLIENTE = ['nombre', 'categoria', 'updatedAt'] as const;

/** RF-24: filtrar clientes por categoría y buscar por nombre/teléfono/email. */
export class QueryClienteDto extends PaginationDto {
  @IsOptional()
  @IsEnum(CategoriaCliente)
  categoria?: CategoriaCliente;

  @IsOptional()
  @IsString()
  busqueda?: string;

  @IsOptional()
  @IsIn(ORDEN_CLIENTE)
  orden?: (typeof ORDEN_CLIENTE)[number];

  @IsOptional()
  @IsIn(DIRECCIONES_ORDEN)
  direccion?: DireccionOrden;
}
