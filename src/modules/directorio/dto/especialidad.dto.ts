import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

import { PaginationDto } from '../../../common/dto/pagination.dto';

const recortar = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CrearEspecialidadDto {
  @Transform(recortar)
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  nombre!: string;

  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(600)
  descripcion?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(9999)
  orden?: number;
}

/** El slug no se edita: la landing ya lo enlaza. */
export class ActualizarEspecialidadDto {
  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  nombre?: string;

  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(600)
  descripcion?: string;

  @IsOptional()
  @IsBoolean()
  activa?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(9999)
  orden?: number;
}

export class QueryEspecialidadesDto extends PaginationDto {
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  incluirInactivas?: boolean;

  @IsOptional()
  @Type(() => String)
  @IsString()
  @MaxLength(80)
  buscar?: string;
}
