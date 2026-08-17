import { Transform, TransformFnParams, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

import { CanalVenta, ClasifComision, NivelPlan, UnidadNegocio } from '@prisma/client';

import { PaginationDto } from '../../../common/dto/pagination.dto';

/**
 * Los flags llegan por query string, siempre como texto. `Type(() => Boolean)`
 * NO sirve aquí: `Boolean('false')` es `true`, así que `?flag=false` activaría
 * el filtro en vez de desactivarlo.
 */
function aBooleano({ value }: TransformFnParams): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  return ['true', '1', 'si', 'sí'].includes(String(value).trim().toLowerCase());
}

/** Filtros de la vista previa de clasificación de un periodo. */
export class QueryVentasImportadasDto extends PaginationDto {
  @IsOptional()
  @IsEnum(ClasifComision)
  clasif?: ClasifComision;

  @IsOptional()
  @IsEnum(CanalVenta)
  canal?: CanalVenta;

  @IsOptional()
  @IsString()
  @Length(1, 40)
  vendedoraId?: string;

  @IsOptional()
  @IsString()
  @Length(1, 40)
  modulo?: string;

  /** Búsqueda por nombre del servicio o del paciente. */
  @IsOptional()
  @IsString()
  @Length(1, 120)
  buscar?: string;

  /** true = solo las filas excluidas del cálculo (para revisarlas). */
  @IsOptional()
  @Transform(aBooleano)
  @IsBoolean()
  soloExcluidas?: boolean;

  /** true = solo los servicios que el clasificador no reconoció. */
  @IsOptional()
  @Transform(aBooleano)
  @IsBoolean()
  soloSinClasificar?: boolean;

  /**
   * true = trae el mes entero de UNA vendedora, sin paginar.
   *
   * No es un capricho de la interfaz: la vista de desempeño busca y filtra en
   * memoria sobre lo que recibe, así que una venta fuera de la página no está
   * "en la siguiente" — no existe para el buscador. Con el tope de 100, la
   * vendedora con 418 ventas tenía 318 invisibles y 9 de sus 61 servicios no se
   * podían encontrar: el buscador no decía "no encontré", decía "no existe".
   *
   * Solo tiene efecto junto a `vendedoraId`, y sigue acotado por
   * `LIMITE_MES_VENDEDORA`. Se pide por bandera y no subiendo `limite` porque
   * el tope de `PaginationDto` es duro por una razón —hay listados con 15.000
   * pacientes detrás— y `class-validator` suma las reglas del padre a las del
   * hijo, así que un `@Max` mayor aquí chocaría con el de arriba en vez de
   * reemplazarlo.
   */
  @IsOptional()
  @Transform(aBooleano)
  @IsBoolean()
  mesCompleto?: boolean;
}

/** Corrección manual de la clasificación de una fila. */
export class AjustarVentaDto {
  @IsOptional()
  @IsEnum(ClasifComision)
  clasif?: ClasifComision;

  @IsOptional()
  @IsEnum(CanalVenta)
  canal?: CanalVenta;

  @IsOptional()
  @IsEnum(UnidadNegocio)
  unidadNegocio?: UnidadNegocio;

  @IsOptional()
  @IsEnum(NivelPlan)
  nivel?: NivelPlan;

  @IsOptional()
  @IsBoolean()
  comisionable?: boolean;

  @IsOptional()
  @IsString()
  @Length(1, 40)
  vendedoraId?: string;

  /**
   * Solo para planes: si ESTE plan comisiona cuando la vendedora superó su
   * objetivo. `null` devuelve la decisión al sistema (base más baja primero).
   */
  @IsOptional()
  @ValidateIf((_objeto, valor) => valor !== null)
  @IsBoolean()
  comisionaPlan?: boolean | null;
}

/** Listado de periodos. */
export class QueryPeriodosDto extends PaginationDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  anio?: number;
}

/**
 * Año y mes de la importación. Se envían solo para forzar un periodo distinto
 * al que el propio archivo declara en su columna `fecha`.
 */
export class ImportarExcelDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  anio?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  mes?: number;

  @IsOptional()
  @Type(() => Number)
  @Min(0.01)
  tipoCambio?: number;
}
