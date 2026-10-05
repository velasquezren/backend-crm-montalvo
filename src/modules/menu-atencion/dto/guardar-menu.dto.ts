import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { CLAVE, LIMITES, TIPOS_OPCION, TipoOpcion } from '../menu-atencion';

/*
 * La forma. Las reglas que cruzan campos (una sola opción de persona, la
 * respuesta obligatoria según el tipo, títulos únicos…) las aplica
 * `erroresDelMenu`, la misma función que valida al leer: aquí no se repiten.
 */

/* `clave`: identidad estable de una respuesta o una promoción. Si falta, la asigna el servidor. */

export class OpcionMenuDto {
  @IsIn(TIPOS_OPCION)
  tipo!: TipoOpcion;

  @IsString()
  @MaxLength(LIMITES.titulo)
  titulo!: string;

  @IsOptional()
  @IsString()
  @MaxLength(LIMITES.descripcion)
  descripcion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(LIMITES.texto)
  respuesta?: string;

  @IsOptional()
  @Matches(CLAVE)
  clave?: string;
}

export class PromocionDto {
  @IsOptional()
  @Matches(CLAVE)
  clave?: string;

  @IsString()
  @MaxLength(LIMITES.titulo)
  titulo!: string;

  @IsOptional()
  @IsString()
  @MaxLength(LIMITES.descripcion)
  descripcion?: string;
}

export class GuardarMenuDto {
  @IsBoolean()
  activo!: boolean;

  @IsString()
  @MaxLength(LIMITES.texto)
  saludo!: string;

  @IsArray()
  @ArrayMaxSize(LIMITES.opciones)
  @ValidateNested({ each: true })
  @Type(() => OpcionMenuDto)
  opciones!: OpcionMenuDto[];

  @IsArray()
  @ArrayMaxSize(LIMITES.promociones)
  @ValidateNested({ each: true })
  @Type(() => PromocionDto)
  promociones!: PromocionDto[];
}
