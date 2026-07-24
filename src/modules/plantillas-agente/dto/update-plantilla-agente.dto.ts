import { PartialType } from '@nestjs/mapped-types';
import { CreatePlantillaAgenteDto } from './create-plantilla-agente.dto';

export class UpdatePlantillaAgenteDto extends PartialType(CreatePlantillaAgenteDto) {}
