import { OmitType, PartialType } from '@nestjs/mapped-types';

import { CreateActividadDto } from './create-actividad.dto';

/**
 * `repetir` queda fuera a propósito: solo tiene sentido al crear, generando
 * las filas nuevas. Editar una actividad ya existente nunca genera otras.
 */
export class UpdateActividadDto extends PartialType(
  OmitType(CreateActividadDto, ['repetir'] as const),
) {}
