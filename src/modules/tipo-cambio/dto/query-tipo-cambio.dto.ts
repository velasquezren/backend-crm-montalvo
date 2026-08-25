import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

/** Un mes calendario — el historial se navega de a uno para no devolver la serie entera. */
export class QueryTipoCambioDto {
  @Type(() => Number)
  @IsInt()
  @Min(2020)
  @Max(2100)
  anio!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  mes!: number;
}
