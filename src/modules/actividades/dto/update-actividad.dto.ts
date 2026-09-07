import { OmitType, PartialType } from '@nestjs/mapped-types';
import { IsOptional, IsString } from 'class-validator';

import { CreateActividadDto } from './create-actividad.dto';

/**
 * `repetir` queda fuera a propósito: solo tiene sentido al crear, generando
 * las filas nuevas. Editar una actividad ya existente nunca genera otras.
 */
export class UpdateActividadDto extends PartialType(
  OmitType(CreateActividadDto, ['repetir', 'leadId'] as const),
) {
  /** null retira el vínculo; omitirlo conserva el lead y obliga a validar su cliente. */
  @IsOptional()
  @IsString()
  leadId?: string | null;
}
