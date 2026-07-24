import { CategoriaRecursoMemoria, TipoRecursoMemoria } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto';

export class QueryRecursoMemoriaDto extends PaginationDto {
  @IsEnum(TipoRecursoMemoria)
  @IsOptional()
  tipo?: TipoRecursoMemoria;

  @IsEnum(CategoriaRecursoMemoria)
  @IsOptional()
  categoria?: CategoriaRecursoMemoria;

  @IsString()
  @IsOptional()
  busqueda?: string;
}
