import { CategoriaRecursoMemoria, TipoRecursoMemoria } from '@prisma/client';
import { IsArray, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateRecursoMemoriaDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  titulo!: string;

  @IsString()
  @IsOptional()
  @MaxLength(5000)
  contenido?: string;

  @IsEnum(TipoRecursoMemoria)
  @IsOptional()
  tipo?: TipoRecursoMemoria;

  @IsEnum(CategoriaRecursoMemoria)
  @IsOptional()
  categoria?: CategoriaRecursoMemoria;

  @IsString()
  @IsOptional()
  @MaxLength(35)
  atajo?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];
}
