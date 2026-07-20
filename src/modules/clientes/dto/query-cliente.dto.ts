import { CategoriaCliente } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';

/** RF-24: filtrar clientes por categoría y buscar por nombre/teléfono/email. */
export class QueryClienteDto {
  @IsOptional()
  @IsEnum(CategoriaCliente)
  categoria?: CategoriaCliente;

  @IsOptional()
  @IsString()
  busqueda?: string;
}
