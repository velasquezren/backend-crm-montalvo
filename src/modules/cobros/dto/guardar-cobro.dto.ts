import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

const recortar = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const vacioANull = ({ value }: { value: unknown }) => (typeof value === 'string' && value.trim() === '' ? null : recortar({ value }));

/** «2026-10-13»: un día de calendario de La Paz. */
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

/** Los datos del QR de una línea. La imagen se sube aparte (`PUT …/qr`). */
export class GuardarCobroDto {
  @IsBoolean()
  activo!: boolean;

  @Transform(recortar)
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  banco!: string;

  @Transform(recortar)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  titular!: string;

  @IsOptional()
  @Transform(vacioANull)
  @IsString()
  @MaxLength(500)
  instrucciones?: string | null;

  /** Ausente o `null` = el QR no vence. */
  @IsOptional()
  @Transform(vacioANull)
  @Matches(FECHA)
  venceEl?: string | null;
}
