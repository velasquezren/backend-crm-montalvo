import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

import { PaginationDto } from '../../../common/dto/pagination.dto';

/** Pestañas del inbox. Espejo de `FiltroInbox` en el frontend. */
export const TABS_INBOX = ['TODAS', 'SIN_RESPONDER', 'SIN_ASIGNAR', 'MIS_CHATS'] as const;
export type TabInbox = (typeof TABS_INBOX)[number];

/**
 * Opciones de vista del inbox. Nada de aquí amplía permisos: el alcance por rol
 * lo pone el controlador con `alcanceAgente()` y se combina con AND.
 *
 * Hereda de `PaginationDto` desde 2026-08-27. Antes el listado no se paginaba:
 * se cortaba en las 500 más recientes y el navegador filtraba pestañas y
 * buscaba sobre ese corte, así que una conversación fuera de él era invisible
 * también para el buscador. Ver `findAll` para el razonamiento completo.
 */
export class QueryConversacionesDto extends PaginationDto {
  /**
   * "Solo míos": asignadas a mí o sin dueño.
   *
   * Llega como texto en la query (`?soloMios=true`), así que se convierte antes
   * de validar. Cualquier cosa que no sea exactamente `"true"` es `false`: un
   * interruptor de la interfaz no debe poder colarse por escribir mal la URL.
   */
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  soloMios?: boolean;

  /** Pestaña activa. Ausente equivale a `TODAS`. */
  @IsOptional()
  @IsIn(TABS_INBOX)
  tab?: TabInbox;

  /**
   * Busca por nombre o teléfono de la paciente sobre el conjunto COMPLETO, no
   * sobre lo que el navegador tenga cargado. El tope de 200 no es decorativo:
   * el `contains` va contra índices GIN trigram, y una cadena larguísima solo
   * sirve para hacer trabajar a Postgres de más.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  busqueda?: string;

  /** Filtro del admin por agente asignado. */
  @IsOptional()
  @IsUUID()
  agenteId?: string;
}
