import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { PaginationDto } from '../../../common/dto/pagination.dto';
import { EstadoPromocion } from '../../../prisma/prisma-client';

const recortar = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
/** Un texto vacío en un campo opcional se guarda como `null`, no como «». */
const vacioANull = ({ value }: { value: unknown }) => (typeof value === 'string' && value.trim() === '' ? null : recortar({ value }));

/** «2026-10-13»: un día de calendario de La Paz. */
export const FECHA = /^\d{4}-\d{2}-\d{2}$/;
/** Bs con dos decimales; el tope es de cordura, no de negocio. */
const PRECIO_MAXIMO = 9_999_999;

export const VIGENCIAS = ['PROXIMA', 'VIGENTE', 'VENCIDA'] as const;

export class CrearPromocionDto {
  @Transform(recortar)
  @IsString()
  @MinLength(3)
  @MaxLength(80)
  titulo!: string;

  @Transform(recortar)
  @IsString()
  @MinLength(3)
  @MaxLength(160)
  resumen!: string;

  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(4000)
  descripcion?: string;

  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(2000)
  condiciones?: string;

  @IsOptional()
  @Transform(vacioANull)
  @IsString()
  @MaxLength(24)
  etiquetaOferta?: string | null;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(PRECIO_MAXIMO)
  precioRegular?: number | null;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(PRECIO_MAXIMO)
  precioPromocional?: number | null;

  @Matches(FECHA)
  vigenteDesde!: string;

  /** Ausente o `null` = sin fecha de fin. */
  @IsOptional()
  @Matches(FECHA)
  vigenteHasta?: string | null;

  @IsOptional()
  @IsBoolean()
  destacada?: boolean;

  @IsOptional()
  @IsBoolean()
  enLanding?: boolean;

  @IsOptional()
  @IsBoolean()
  enWhatsapp?: boolean;

  @IsOptional()
  @IsUUID()
  especialidadId?: string | null;

  /** Fichas del directorio médico que atienden la promoción. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  medicoIds?: string[];
}

/**
 * Edición. `version` es la que leyó quien edita: si otra persona guardó
 * entretanto, 409 en vez de pisarla. Lo ausente no cambia; `null` borra.
 */
export class ActualizarPromocionDto {
  @IsInt()
  @Min(1)
  version!: number;

  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MinLength(3)
  @MaxLength(80)
  titulo?: string;

  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MinLength(3)
  @MaxLength(160)
  resumen?: string;

  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(4000)
  descripcion?: string;

  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(2000)
  condiciones?: string;

  @IsOptional()
  @Transform(vacioANull)
  @IsString()
  @MaxLength(24)
  etiquetaOferta?: string | null;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(PRECIO_MAXIMO)
  precioRegular?: number | null;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(PRECIO_MAXIMO)
  precioPromocional?: number | null;

  @IsOptional()
  @Matches(FECHA)
  vigenteDesde?: string;

  @IsOptional()
  @Matches(FECHA)
  vigenteHasta?: string | null;

  @IsOptional()
  @IsBoolean()
  destacada?: boolean;

  @IsOptional()
  @IsBoolean()
  enLanding?: boolean;

  @IsOptional()
  @IsBoolean()
  enWhatsapp?: boolean;

  @IsOptional()
  @IsUUID()
  especialidadId?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  medicoIds?: string[];
}

export class DevolverPromocionDto {
  @Transform(recortar)
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  motivo!: string;
}

/** Llega como campo de texto del formulario multipart, junto al archivo. */
export class SubirBannerDto {
  @Transform(recortar)
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  textoAlternativo!: string;
}

export class QueryPromocionesDto extends PaginationDto {
  @IsOptional()
  @IsEnum(EstadoPromocion)
  estado?: EstadoPromocion;

  @IsOptional()
  @IsIn(VIGENCIAS)
  vigencia?: (typeof VIGENCIAS)[number];

  @IsOptional()
  @Type(() => String)
  @IsString()
  @MaxLength(80)
  buscar?: string;

  @IsOptional()
  @IsUUID()
  especialidadId?: string;
}

/** Anuncios de Meta que trajeron pacientes y todavía no están enlazados a una promoción. */
export class QueryAnunciosSinPromocionDto extends PaginationDto {}

/** El id de un anuncio de Meta (`source_id` o `ad_id`): dígitos, a veces con `_`. */
export const ANUNCIO_ID = /^[0-9_]{3,64}$/;

export const CANALES_PUBLICOS = ['landing', 'whatsapp'] as const;

export class QueryPromocionesPublicasDto extends PaginationDto {
  /** Slug de la especialidad. */
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9-]{1,80}$/)
  especialidad?: string;

  /** Para qué canal: cada promoción elige dónde se ofrece. Por defecto, la landing. */
  @IsOptional()
  @IsIn(CANALES_PUBLICOS)
  canal?: (typeof CANALES_PUBLICOS)[number];
}
