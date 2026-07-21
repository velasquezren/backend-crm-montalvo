import { CategoriaCliente } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';

import { PaginationDto } from '../../../common/dto/pagination.dto';

/** RF-24: filtrar clientes por categoría y buscar por nombre/teléfono/email. */
export class QueryClienteDto extends PaginationDto {
  @IsOptional()
  @IsEnum(CategoriaCliente)
  categoria?: CategoriaCliente;

  @IsOptional()
  @IsString()
  busqueda?: string;
}
