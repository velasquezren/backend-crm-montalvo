import { IsString, MinLength } from 'class-validator';

export class EnviarMensajeDto {
  @IsString()
  @MinLength(1)
  contenido!: string;
}
