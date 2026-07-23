import { IsArray, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Envío de una plantilla de WhatsApp (mensaje iniciado por la empresa, fuera
 * de la ventana de 24h). El nombre + idioma + parámetros arman la llamada real
 * a Meta; `contenido` es el texto ya renderizado (lo que el agente vio en la
 * previsualización) y se guarda como el cuerpo del Mensaje en el CRM.
 */
export class EnviarPlantillaDto {
  /** Nombre de la plantilla aprobada en la WABA (ej. `recordatorio_cita`). */
  @IsString()
  @MaxLength(512)
  plantilla!: string;

  /** Código de idioma de la plantilla (ej. `es`). */
  @IsString()
  @MaxLength(10)
  idioma!: string;

  /** Valores para las variables del cuerpo, en orden. Vacío si la plantilla no tiene. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  parametros?: string[];

  /** Texto ya renderizado (con las variables sustituidas) para guardar en el historial. */
  @IsString()
  @MaxLength(4096)
  contenido!: string;
}
