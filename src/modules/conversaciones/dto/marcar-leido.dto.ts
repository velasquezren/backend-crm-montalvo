import { IsBoolean, IsOptional } from 'class-validator';

/**
 * Marca el último mensaje entrante como leído (tildes azules para el paciente).
 * Si `typing` es true, además muestra el indicador "escribiendo…" (se auto-cierra
 * a los 25s o al enviar). Ver ConversacionesService.marcarLeido.
 */
export class MarcarLeidoDto {
  @IsOptional()
  @IsBoolean()
  typing?: boolean;
}
