import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class EnviarMensajeDto {
  /**
   * 4096 es el máximo que acepta WhatsApp para un mensaje de texto: más largo
   * lo rechaza Meta y el mensaje queda FALLIDO después de haberse guardado y
   * mostrado al agente como enviado. Mejor un 400 al escribirlo. Es el mismo
   * tope que ya tenía `EnviarPlantillaDto.contenido`.
   *
   * Con adjunto puede ir vacío: ahí hace de pie de foto.
   */
  @IsString()
  @MinLength(0)
  @MaxLength(4096)
  contenido!: string;

  /**
   * Clave del archivo en R2, cuando el agente adjunta algo.
   *
   * Va la CLAVE y no la URL a propósito. Antes el frontend pegaba en el texto la
   * URL firmada que devolvía la subida, y esa firma caduca a los 15 minutos: el
   * paciente recibía bien la foto —WhatsApp la descarga al instante— pero en el
   * CRM la burbuja se rompía un cuarto de hora después y el agente veía solo
   * "Imagen adjunta". Guardando la clave, el detalle firma una URL nueva en cada
   * carga, que es justo lo que ya hacían las imágenes ENTRANTES y por eso esas
   * sí se veían siempre.
   */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  mediaKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  mediaMime?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  mediaNombre?: string;
}
