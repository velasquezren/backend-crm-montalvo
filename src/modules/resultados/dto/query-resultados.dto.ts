import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';

import { PaginationDto } from '../../../common/dto/pagination.dto';

/**
 * Las pestañas de la cola, por lo que la asistente tiene que HACER:
 *
 * - `POR_AVISAR`: enlace vigente, sin abrir, sin aviso (o con aviso fallido).
 * - `ESPERANDO`: avisada, vigente y todavía sin abrir.
 * - `VENCIDOS`: el enlace venció sin que lo abriera → «Renovar y enviar».
 * - `ABIERTOS`: la paciente ya lo vio.
 * - `TODOS`.
 *
 * Espejo en el frontend: `features/resultados/resultado.model.ts`.
 */
export const ESTADOS_COLA = ['POR_AVISAR', 'ESPERANDO', 'VENCIDOS', 'ABIERTOS', 'TODOS'] as const;
export type EstadoCola = (typeof ESTADOS_COLA)[number];

/**
 * La cola de entrega. Cada pestaña se pagina donde vive su dato: las del
 * portal (vencidos, abiertos, todos) en el portal; las que dependen de si se
 * avisó —que solo sabe el CRM— sobre el conjunto de trabajo entero que da el
 * portal. Filtrar aquí una página ya cortada haría mentir a la paginación.
 */
export class QueryResultadosDto extends PaginationDto {
  @IsOptional()
  @IsIn(ESTADOS_COLA)
  estado?: EstadoCola;

  /** Nombre, PAC o CI. Viaja crudo al portal, que es quien arma el LIKE y lo escapa. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(2, 80)
  busqueda?: string;
}
