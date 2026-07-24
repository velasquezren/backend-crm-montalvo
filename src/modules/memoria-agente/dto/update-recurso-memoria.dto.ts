import { PartialType } from '@nestjs/mapped-types';
import { CreateRecursoMemoriaDto } from './create-recurso-memoria.dto';

export class UpdateRecursoMemoriaDto extends PartialType(CreateRecursoMemoriaDto) {}
