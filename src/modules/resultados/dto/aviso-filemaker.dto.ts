import { Transform } from 'class-transformer';
import { IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';

/** Lo que manda el guion de FileMaker además del informe que va en la ruta. */
export class AvisoFilemakerDto {
  /**
   * La cuenta de FileMaker de quien pulsó el botón (`Get ( AccountName )`).
   * No autentica nada —eso lo hace la credencial—: queda en la auditoría para
   * saber qué asistente pidió el aviso, porque en el chat figura la cuenta
   * fija «FileMaker» del CRM.
   */
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 80)
  @Matches(/^[^\u0000-\u001f\u007f]+$/, { message: 'usuario no puede llevar caracteres de control' })
  usuario!: string;

  /**
   * El número que la asistente vio y aceptó en la confirmación (lo que dio
   * `…/destino`). Si la ficha cambió de número entre la pregunta y el «Enviar»,
   * no se envía: se confirmó otro destino. Vacío = la ficha no tenía teléfono
   * (solo usuario de WhatsApp). Sin el campo no se compara (guiones viejos).
   */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(30)
  @Matches(/^\+?[0-9]*$/, { message: 'telefonoConfirmado solo admite dígitos y un + inicial' })
  telefonoConfirmado?: string;
}

/** «Cambiar número» desde FileMaker: el número que escribió la asistente. */
export class TelefonoFilemakerDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 80)
  @Matches(/^[^\u0000-\u001f\u007f]+$/, { message: 'usuario no puede llevar caracteres de control' })
  usuario!: string;

  /** Tal como lo escribió: `70012345`, `+591 700 12345`… El servidor lo normaliza. */
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(6, 30)
  @Matches(/^[+0-9 ()-]+$/, { message: 'telefono solo admite dígitos, espacios, guiones, paréntesis y un +' })
  telefono!: string;
}
