import { IsOptional, IsUUID } from 'class-validator';

/** DTO para asignar/desasignar agente a una conversación. agenteId = null desasigna. */
export class AsignarAgenteDto {
  @IsUUID()
  @IsOptional()
  agenteId: string | null;
}
