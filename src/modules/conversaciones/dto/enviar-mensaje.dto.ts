import { IsString, MaxLength, MinLength } from 'class-validator';

export class EnviarMensajeDto {
  /**
   * 4096 es el máximo que acepta WhatsApp para un mensaje de texto: más largo
   * lo rechaza Meta y el mensaje queda FALLIDO después de haberse guardado y
   * mostrado al agente como enviado. Mejor un 400 al escribirlo. Es el mismo
   * tope que ya tenía `EnviarPlantillaDto.contenido`.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  contenido!: string;
}
