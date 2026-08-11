import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

/**
 * Opciones de vista del inbox. Nada de aquí amplía permisos: el alcance por rol
 * lo pone el controlador con `alcanceAgente()` y se combina con AND.
 */
export class QueryConversacionesDto {
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
}
