import { IsEnum, ValidateIf } from 'class-validator';

import { CategoriaCliente } from '../../../prisma/prisma-client';

/**
 * `PUT /clientes/:id/categoria`. Una categoría la fija a mano; `null` la
 * devuelve al cálculo automático. Obligatorio y explícito a propósito: un
 * cuerpo vacío no puede leerse como «vuelve a automática».
 */
export class FijarCategoriaDto {
  @ValidateIf((dto: FijarCategoriaDto) => dto.categoria !== null)
  @IsEnum(CategoriaCliente)
  categoria!: CategoriaCliente | null;
}
