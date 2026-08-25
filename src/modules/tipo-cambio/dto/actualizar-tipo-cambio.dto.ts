import { IsNumber, IsPositive } from 'class-validator';

/** Corrección manual de un día concreto — siempre gana sobre un valor automático. */
export class ActualizarTipoCambioDto {
  @IsNumber({ maxDecimalPlaces: 4 })
  @IsPositive()
  valor!: number;
}
