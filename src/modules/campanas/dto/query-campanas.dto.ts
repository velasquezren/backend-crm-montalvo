import { IsIn, IsOptional } from 'class-validator';

import { PaginationDto } from '../../../common/dto/pagination.dto';

/** Listado de campañas: solo paginación. */
export class QueryCampanasDto extends PaginationDto {}

export const ESTADOS_DESTINATARIO = ['PENDIENTE', 'ENVIANDO', 'ENVIADO', 'OMITIDO', 'FALLIDO'] as const;

/** Las pacientes de una campaña, de una en una página, por estado si se pide. */
export class QueryDestinatariosDto extends PaginationDto {
  @IsOptional()
  @IsIn(ESTADOS_DESTINATARIO)
  estado?: (typeof ESTADOS_DESTINATARIO)[number];
}
