import { IsBoolean } from "class-validator";

/** `true` = los mensajes de esa línea le suenan; `false` = silenciada. */
export class FijarAvisoDto {
  @IsBoolean()
  suena!: boolean;
}
