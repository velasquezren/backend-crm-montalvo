import { IsString, MaxLength, MinLength } from 'class-validator';

/** Un número de caja, como lo escribe quien lo agrega (el teléfono se normaliza a E.164). */
export class AgregarNumeroCajaDto {
  @IsString() @MinLength(2) @MaxLength(80)
  nombre!: string;

  @IsString() @MinLength(7) @MaxLength(30)
  telefono!: string;
}
