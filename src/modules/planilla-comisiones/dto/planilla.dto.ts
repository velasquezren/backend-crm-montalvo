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

import {
  CanalVenta,
  ClasifComision,
  NivelPlan,
  TipoComision,
  UnidadNegocio,
} from '../../../prisma/prisma-client';

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

/**
 * Único parámetro de los informes por persona: si las vendedoras dadas de baja
 * entran o no.
 *
 * Por defecto **no** entran — para eso se las oculta. Se marca a mano para
 * reeditar un mes en el que la persona sí trabajaba, así que la decisión es
 * siempre explícita y nunca la que trae el sistema por defecto.
 */
export class QueryInformeDto {
  @IsOptional()
  @Transform(aBooleano)
  @IsBoolean()
  incluirOcultas?: boolean;
}

/** Filtros de la vista previa de clasificación de un periodo. */
export class QueryVentasImportadasDto extends PaginationDto {
  @IsOptional()
  @IsEnum(ClasifComision)
  clasif?: ClasifComision;

  @IsOptional()
  @IsEnum(CanalVenta)
  canal?: CanalVenta;

  /**
   * Tipo de comisión (A/B/C), que es como se agrupan las columnas de la
   * liquidación. Sale de la clasificación —A planes, B cirugías, C el resto—
   * pero se filtra aparte porque revisar "todo lo que paga por Tipo B" cruza
   * varias clasificaciones y era lo único que no se podía acotar.
   */
  @IsOptional()
  @IsEnum(TipoComision)
  tipo?: TipoComision;

  /** Maternidad / RA / Varios — para aislar, por ejemplo, todo lo del área RA. */
  @IsOptional()
  @IsEnum(UnidadNegocio)
  unidadNegocio?: UnidadNegocio;

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

  /**
   * Por qué se saca esta venta del cálculo. **Obligatorio al excluir a mano.**
   *
   * Quitarle la comisión a una fila es mover dinero de una persona, y sin motivo
   * la decisión es irrecuperable: dentro de tres meses nadie sabe si fue un
   * error del Excel, una devolución o un criterio de administración. El motivo
   * viaja también al registro de auditoría.
   *
   * 200 es el ancho real de la columna (`@db.VarChar(200)`): sin el tope, un
   * texto largo pasaría la validación y reventaría en Postgres con un 500.
   */
  @IsOptional()
  @IsString()
  @Length(3, 200)
  motivoExclusion?: string;

  @IsOptional()
  @IsString()
  @Length(1, 40)
  vendedoraId?: string;

  /**
   * Solo para planes: si ESTE plan comisiona cuando la vendedora superó su
   * objetivo. `null` devuelve la decisión al sistema, que elige los últimos
   * planes vendidos hasta llenar el cupo.
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

/** Cambio de estado del periodo de comisiones. */
/**
 * Motivo de un rechazo o de una reapertura.
 *
 * Obligatorio, y con la misma razón que `motivoExclusion` en una venta: los dos
 * saltos deshacen algo que otra persona ya había dado por bueno. Sin motivo,
 * dentro de tres meses nadie sabe si un mes se reabrió por un error del Excel,
 * por una devolución o por un clic equivocado — y en el caso de reabrir, además,
 * se descartó la foto de las reglas con las que se había cerrado.
 */
export class MotivoPeriodoDto {
  @IsString()
  @Length(3, 300)
  motivo!: string;
}

/** El visto bueno de un SUPER_ADMIN. El comentario es opcional. */
export class AprobarPeriodoDto {
  @IsOptional()
  @IsString()
  @Length(0, 300)
  comentario?: string;
}
