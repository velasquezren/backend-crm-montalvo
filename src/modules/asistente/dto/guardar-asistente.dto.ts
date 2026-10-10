import { IsBoolean, IsIn, IsString, MaxLength } from 'class-validator';

import { ModoAsistente } from '../../../prisma/prisma-client';
import { LIMITES_ASISTENTE, MODOS_ASISTENTE } from '../asistente-lineas.service';

/** La configuración entera de una línea: se edita y se guarda de una vez. */
export class GuardarAsistenteDto {
  @IsIn(MODOS_ASISTENTE)
  modo!: ModoAsistente;

  @IsString()
  @MaxLength(LIMITES_ASISTENTE.conocimiento)
  conocimiento!: string;

  @IsString()
  @MaxLength(LIMITES_ASISTENTE.criterioDerivacion)
  criterioDerivacion!: string;

  @IsBoolean()
  leerComprobantes!: boolean;
}
