import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, MaxLength, Min } from 'class-validator';

import { TIPOS_INFORME } from '../tipo-informe';
import { PATRON_MES, VERSIONES_CONSTANCIA, VersionConstancia } from './query-constancia.dto';

const recortar = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** El mes en la ruta: `/resultados/constancia/2026-11/...`. */
export class MesConstanciaDto {
  @Matches(PATRON_MES, { message: 'mes debe tener la forma AAAA-MM' })
  mes!: string;
}

/** Deshacer una validación exige decir por qué: queda en la auditoría junto a la copia. */
export class AnularValidacionDto {
  @Transform(recortar)
  @IsString()
  @Length(5, 300, { message: 'Explica el motivo (entre 5 y 300 caracteres).' })
  motivo!: string;
}

/** Los grupos de la constancia: los tipos de informe y los que ya no están en el portal. */
export const GRUPOS_CONSTANCIA = [...TIPOS_INFORME, 'SIN_PORTAL'] as const;

/** Lo que se imprimió: queda quién, cuándo y con qué recorte. */
export class ImpresionConstanciaDto {
  /** Un solo tipo de informe, o ausente si se imprimió el mes entero. */
  @IsOptional()
  @IsIn(GRUPOS_CONSTANCIA)
  tipo?: (typeof GRUPOS_CONSTANCIA)[number];

  /** El filtro dicho en palabras (estado, búsqueda), tal como sale en la cabecera del papel. */
  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(200)
  filtro?: string;

  @IsInt()
  @Min(0)
  @Max(100_000)
  filas!: number;

  @IsIn(VERSIONES_CONSTANCIA)
  version!: VersionConstancia;
}
