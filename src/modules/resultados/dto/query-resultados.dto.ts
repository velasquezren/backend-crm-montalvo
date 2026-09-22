import { PaginationDto } from '../../../common/dto/pagination.dto';

/**
 * La cola de entrega se pagina contra el portal de resultados, que es quien
 * tiene el total real. No hay filtros propios todavía: añadir uno exige que el
 * portal sepa filtrarlo, o la paginación mentiría.
 */
export class QueryResultadosDto extends PaginationDto {}
