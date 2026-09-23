import { IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateIf } from 'class-validator';

import { EnviarPlantillaDto } from './enviar-plantilla.dto';

/**
 * Escribirle primero a alguien —una paciente de la base o un número nuevo—
 * desde una línea concreta. Siempre con plantilla: sin un mensaje suyo no hay
 * ventana de 24 h y Meta no entrega texto libre.
 *
 * Una de dos: `clienteId` (una ficha existente) o `telefono` (se busca y, si no
 * existe, se da de alta con `nombre`).
 */
export class IniciarConversacionDto extends EnviarPlantillaDto {
  @IsUUID()
  lineaId!: string;

  @ValidateIf((dto: IniciarConversacionDto) => !dto.telefono)
  @IsUUID()
  clienteId?: string;

  @ValidateIf((dto: IniciarConversacionDto) => !dto.clienteId)
  @IsString()
  @MinLength(8)
  @MaxLength(30)
  telefono?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  nombre?: string;
}
