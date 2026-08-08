import { IsIn, IsISO8601, IsOptional, IsString, Length } from 'class-validator';

import {
  DIRECCIONES_ORDEN,
  DireccionOrden,
  PaginationDto,
} from '../../../common/dto/pagination.dto';

/** Filtros del dashboard de servicios. */
export class QueryServiciosDto {
  /** Acota a un mes ya importado. Sin él, el dashboard mira todo el historial. */
  @IsOptional()
  @IsString()
  periodoId?: string;

  /** `LABORATORIO`, `CONSULTA`, `PLANES`, `INTERNACION`… tal como viene del Excel. */
  @IsOptional()
  @IsString()
  @Length(1, 40)
  modulo?: string;

  @IsOptional()
  @IsISO8601()
  desde?: string;

  @IsOptional()
  @IsISO8601()
  hasta?: string;
}

/**
 * Columnas ordenables de los dos listados agregados.
 *
 * **Listas cerradas y traducidas a SQL en el service** (ver `ORDEN_SQL_*`): estos
 * listados son `$queryRaw` con `GROUP BY`, así que el nombre de columna acaba
 * interpolado en la consulta. Interpolar ahí lo que mande el cliente es una
 * inyección SQL de manual; por eso lo que viaja es una CLAVE de un diccionario,
 * nunca el nombre de la columna.
 */
export const ORDEN_PACIENTES = ['paciente', 'servicios', 'gastado', 'ultima'] as const;
export const ORDEN_MEDICOS = ['nombre', 'servicios', 'pacientes', 'ingreso', 'ultima'] as const;

/** Listado de pacientes con servicios. */
export class QueryPacientesDto extends PaginationDto {
  /** Cruza contra el nombre y el código del paciente. */
  @IsOptional()
  @IsString()
  @Length(1, 120)
  busqueda?: string;

  @IsOptional()
  @IsIn(ORDEN_PACIENTES)
  orden?: (typeof ORDEN_PACIENTES)[number];

  @IsOptional()
  @IsIn(DIRECCIONES_ORDEN)
  direccion?: DireccionOrden;
}

/** Listado de médicos. */
export class QueryMedicosDto extends PaginationDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  busqueda?: string;

  @IsOptional()
  @IsIn(ORDEN_MEDICOS)
  orden?: (typeof ORDEN_MEDICOS)[number];

  @IsOptional()
  @IsIn(DIRECCIONES_ORDEN)
  direccion?: DireccionOrden;
}
