import { Transform, Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsBoolean, IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';

import { PaginationDto } from '../../../common/dto/pagination.dto';
import { CategoriaCliente } from '../../../prisma/prisma-client';

/** Por defecto se mira a quien vale la pena: Gold y Silver. */
export const CATEGORIAS_POR_DEFECTO: readonly CategoriaCliente[] = [CategoriaCliente.GOLD, CategoriaCliente.SILVER];
/** Sin otra campaña de marketing en este plazo, salvo que se pida otro. */
export const DIAS_SIN_CAMPANA_POR_DEFECTO = 30;

/**
 * Quiénes forman una audiencia. Nada de esto amplía permisos: la ruta es
 * ADMIN+ y la consulta solo LEE.
 */
export class QueryAudienciaDto extends PaginationDto {
  /**
   * Categorías a incluir. En la query van separadas por coma
   * (`?categorias=GOLD,SILVER`) o repetidas; se convierten antes de validar.
   */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    (Array.isArray(value) ? value : String(value).split(',')).map(v => String(v).trim()).filter(Boolean),
  )
  @IsArray()
  @ArrayMinSize(1)
  @IsEnum(CategoriaCliente, { each: true })
  categorias?: CategoriaCliente[];

  /**
   * Deja fuera a quien recibió una plantilla de MARKETING en estos días. `0`
   * no deja fuera a nadie por eso. Meta limita cuántas recibe cada persona y
   * repetirlas pronto solo devuelve el error 131049.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(365)
  diasSinCampana?: number;

  /**
   * Solo quienes alguna vez nos escribieron por WhatsApp: el número es suyo,
   * está en WhatsApp y ya conversó con la clínica. Mismo criterio que
   * `soloMios` del inbox: solo `"true"` es verdadero.
   */
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  soloConversaron?: boolean;
}
