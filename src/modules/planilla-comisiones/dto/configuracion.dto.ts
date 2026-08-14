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
  CanalVenta,
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
  /** Paquetes de maternidad a superar (no basta con igualar) para comisionar Tipo A. */
  @IsInt()
  @Min(0)
  planpaqMinimos!: number;

  /** Planes varios / niño sano. Objetivo independiente del anterior. */
  @IsInt()
  @Min(0)
  planninMinimos!: number;

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

  /**
   * `@Type` no es opcional aquí, y costó caro descubrirlo.
   *
   * `sueldoBase` es un `Decimal` en Prisma, y un Decimal se serializa a JSON
   * como TEXTO: el mismo objeto que el frontend recibe (`"2750"`) es el que
   * devuelve al guardar. El `ValidationPipe` global corre con
   * `enableImplicitConversion: false`, así que ese texto no se convierte solo,
   * `@IsNumber()` lo rechaza y el PATCH responde 400.
   *
   * El fallo era invisible desde la interfaz: el input conserva lo tecleado
   * porque Angular solo reescribe el DOM cuando la expresión enlazada cambia
   * —y seguía valiendo 0—, así que la pantalla mostraba el sueldo y la base
   * tenía cero. Se descubrió porque toda la columna "Sueldo" de la planilla
   * salía en Bs 0,00 con las liquidaciones ya calculadas.
   *
   * Cualquier campo `Decimal` que vuelva por un DTO necesita esta línea.
   */
  @IsOptional()
  @Type(() => Number)
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

/**
 * Alta o cambio de un valor de captación. `valor` viaja normalizado (mayúsculas,
 * sin tildes) porque así es como el clasificador compara contra el Excel.
 */
export class GuardarMapeoCaptacionDto {
  @IsEnum(CanalVenta)
  canal!: CanalVenta;
}
