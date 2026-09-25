import { IsOptional, IsUUID } from 'class-validator';

/**
 * Enviar el pin de ubicación de la clínica desde el chat. No lleva contenido:
 * el lugar es uno solo (`UBICACION_CLINICA`). `clientMessageId` cumple lo mismo
 * que en `EnviarMensajeDto`: un doble clic o un reintento no manda dos pines.
 */
export class EnviarUbicacionDto {
  @IsOptional()
  @IsUUID()
  clientMessageId?: string;
}
