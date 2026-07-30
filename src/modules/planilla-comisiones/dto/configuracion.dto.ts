import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

import {
  AreaVendedora,
  ClasifComision,
  NivelPlan,
  TipoVendedora,
  UnidadNegocio,
} from '@prisma/client';

/** Los porcentajes se manejan como número entero/decimal de porcentaje: 4.5 = 4,5%. */
const PCT = { min: 0, max: 100 } as const;

export class ActualizarTarifaPlanDto {
  @IsNumber()
  @Min(PCT.min)
  @Max(PCT.max)
  pctEmpresa!: number;

  @IsNumber()
  @Min(PCT.min)
  @Max(PCT.max)
  pctPropio!: number;
}

export class ActualizarTarifaServicioDto extends ActualizarTarifaPlanDto {}

export class ActualizarNivelCirugiaDto {
  @IsNumber()
  @Min(0)
  montoDesde!: number;

  @IsNumber()
  @Min(0)
  montoHasta!: number;

  @IsNumber()
  @Min(PCT.min)
  @Max(PCT.max)
  pctEmpresa!: number;

  @IsNumber()
  @Min(PCT.min)
  @Max(PCT.max)
  pctPropio!: number;
}

export class ActualizarTarifaRaDto {
  /** USD fijos por procedimiento, o porcentaje si `esPorcentaje` está activo. */
  @IsNumber()
  @Min(0)
  montoEmpresa!: number;

  @IsNumber()
  @Min(0)
  montoPropio!: number;

  @IsOptional()
  @IsBoolean()
  esPorcentaje?: boolean;
}

export class ActualizarObjetivoDto {
  @IsInt()
  @Min(0)
  planesMinimos!: number;

  @IsNumber()
  @Min(0)
  montoMensualUsd!: number;

  @IsNumber()
  @Min(0)
  montoTrimestralUsd!: number;
}

export class ActualizarParametroDto {
  @IsNumber()
  valor!: number;
}

export class CrearReglaDto {
  @IsString()
  @Length(1, 200)
  patron!: string;

  @IsOptional()
  @IsBoolean()
  exacto?: boolean;

  @IsOptional()
  @IsString()
  @Length(1, 40)
  modulo?: string;

  @IsEnum(ClasifComision)
  clasif!: ClasifComision;

  @IsOptional()
  @IsEnum(NivelPlan)
  nivel?: NivelPlan;

  @IsOptional()
  @IsEnum(UnidadNegocio)
  unidadNegocio?: UnidadNegocio;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  prioridad?: number;

  @IsOptional()
  @IsBoolean()
  activa?: boolean;

  @IsOptional()
  @IsString()
  @Length(0, 300)
  notas?: string;
}

/** Alta/edición de una persona que comisiona. */
export class ActualizarVendedoraDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  nombre?: string;

  @IsOptional()
  @IsEnum(TipoVendedora)
  tipo?: TipoVendedora;

  /** EJECUTIVA (comisiona A/B/C) · RA (tarifa fija por procedimiento) · PUBLICIDAD (solo bono). */
  @IsOptional()
  @IsEnum(AreaVendedora)
  area?: AreaVendedora;

  @IsOptional()
  @IsNumber()
  @Min(0)
  sueldoBase?: number;

  @IsOptional()
  @IsBoolean()
  activa?: boolean;

  /** Marca a la vendedora como revisada por administración. */
  @IsOptional()
  @IsBoolean()
  configurada?: boolean;
}
