import { PartialType } from '@nestjs/mapped-types';

import { CreateActividadDto } from './create-actividad.dto';

export class UpdateActividadDto extends PartialType(CreateActividadDto) {}
