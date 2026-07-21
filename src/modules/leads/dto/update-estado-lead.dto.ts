import { EstadoLead } from '@prisma/client';
import { IsEnum } from 'class-validator';

/**
 * Movimiento de una tarjeta en el pipeline kanban.
 * Sin este DTO el endpoint aceptaba cualquier cadena y Prisma reventaba con un 500;
 * ahora un estado inválido devuelve 400 con el detalle (CRM_MANIFESTO.md §1.1 —
 * toda entrada externa se valida antes de tocar la lógica de negocio).
 */
export class UpdateEstadoLeadDto {
  @IsEnum(EstadoLead)
  estado!: EstadoLead;
}
