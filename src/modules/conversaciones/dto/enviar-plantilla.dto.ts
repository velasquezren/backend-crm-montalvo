import { ArrayMaxSize, IsArray, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * Envío de una plantilla de WhatsApp (mensaje iniciado por la empresa, fuera
 * de la ventana de 24h).
 *
 * **El texto no viaja.** Antes llegaba un `contenido` compuesto en el
 * navegador y era el cuerpo SIN sustituir: el historial del CRM guardaba
 * «Hola {{1}}» en vez de lo que recibió el paciente. Ahora el servidor busca
 * la plantilla aprobada de la línea, valida las variables y compone el texto
 * (`renderizarPlantilla`). Un `contenido` de un cliente viejo se descarta sin
 * error: el `ValidationPipe` global solo lista blanca.
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

  /** Valores de las variables del cuerpo, en el orden de `nombresVariables`. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(1024, { each: true })
  parametros?: string[];

  /**
   * Clave de la INTENCIÓN de envío, igual que en `EnviarMensajeDto`: un doble
   * clic o el reintento de una respuesta perdida devuelven el mismo mensaje en
   * vez de mandar —y cobrar— la plantilla dos veces. Opcional solo mientras
   * convivan clientes viejos durante el despliegue.
   */
  @IsOptional()
  @IsUUID()
  clientMessageId?: string;
}
