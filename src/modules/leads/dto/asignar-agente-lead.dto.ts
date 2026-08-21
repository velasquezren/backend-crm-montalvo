import { IsOptional, IsUUID } from 'class-validator';

/** DTO para asignar/desasignar agente a un lead. agenteId = null desasigna. */
export class AsignarAgenteLeadDto {
  @IsUUID()
  @IsOptional()
  agenteId!: string | null;
}
