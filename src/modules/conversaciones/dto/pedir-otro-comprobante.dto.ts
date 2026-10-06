import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

/** Por qué no sirve el comprobante. Se le dice a la paciente tal cual: escríbelo para ella. */
export class PedirOtroComprobanteDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  motivo!: string;
}
