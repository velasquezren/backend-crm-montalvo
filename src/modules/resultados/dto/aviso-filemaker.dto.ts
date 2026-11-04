import { Transform } from 'class-transformer';
import { IsString, Length, Matches } from 'class-validator';

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
}
