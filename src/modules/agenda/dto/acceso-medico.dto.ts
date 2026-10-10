import { IsString, MaxLength, MinLength } from 'class-validator';

/** El número de WhatsApp del médico, como lo escribe quien lo autoriza (se normaliza a E.164). */
export class AutorizarTelefonoMedicoDto {
  @IsString() @MinLength(7) @MaxLength(30)
  telefono!: string;
}
