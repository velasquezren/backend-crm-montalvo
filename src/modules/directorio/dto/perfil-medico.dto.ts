import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { PaginationDto } from '../../../common/dto/pagination.dto';
import { DIAS_SEMANA, HORA } from '../horario';

const recortar = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
/** Un texto vacío en un campo opcional se guarda como `null`, no como «». */
const vacioANull = ({ value }: { value: unknown }) => (typeof value === 'string' && value.trim() === '' ? null : recortar({ value }));

export class CrearPerfilMedicoDto {
  @Transform(recortar)
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  nombrePublico!: string;

  /** El `Medico` de comisiones (código de FileMaker) que es esta persona. */
  @IsOptional()
  @IsUUID()
  medicoId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  especialidadIds?: string[];
}

/**
 * Edición de la ficha. `version` es la que leyó quien edita: si otra persona
 * guardó entretanto, 409 en vez de pisarla.
 */
export class ActualizarPerfilMedicoDto {
  @IsInt()
  @Min(1)
  version!: number;

  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  nombrePublico?: string;

  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(300)
  resumen?: string;

  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(3000)
  biografia?: string;

  @IsOptional()
  @Transform(vacioANull)
  @IsString()
  @MaxLength(40)
  matricula?: string | null;

  /** En Bs, con dos decimales. `null` = no se publica precio. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(99_999_999)
  precioConsulta?: number | null;

  /** `null` = desvincular del médico de comisiones. */
  @IsOptional()
  @IsUUID()
  medicoId?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(9999)
  orden?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  especialidadIds?: string[];
}

export class BloqueHorarioDto {
  @IsInt()
  @IsIn(DIAS_SEMANA)
  diaSemana!: number;

  /** «08:00». */
  @Matches(HORA)
  desde!: string;

  /** «12:30». `24:00` = hasta medianoche. */
  @Matches(HORA)
  hasta!: string;

  @IsOptional()
  @Transform(vacioANull)
  @IsString()
  @MaxLength(80)
  lugar?: string | null;
}

/** El horario semanal se guarda entero: es un documento que se edita y guarda de una vez. */
export class GuardarHorarioDto {
  @IsInt()
  @Min(1)
  version!: number;

  @IsArray()
  @ArrayMaxSize(28)
  @ValidateNested({ each: true })
  @Type(() => BloqueHorarioDto)
  bloques!: BloqueHorarioDto[];
}

export class CrearAusenciaDto {
  /** «2026-12-20», día de La Paz. */
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  desde!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  hasta!: string;

  @IsOptional()
  @Transform(vacioANull)
  @IsString()
  @MaxLength(120)
  motivoPublico?: string | null;
}

export class PublicarPerfilDto {
  @IsBoolean()
  publicado!: boolean;
}

export class QueryPerfilesMedicosDto extends PaginationDto {
  @IsOptional()
  @Type(() => String)
  @IsString()
  @MaxLength(80)
  buscar?: string;

  @IsOptional()
  @IsUUID()
  especialidadId?: string;

  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  publicado?: boolean;
}

/** Médicos del importador de comisiones que todavía no tienen ficha, para enlazarlos. */
export class QueryMedicosSinFichaDto extends PaginationDto {
  @IsOptional()
  @Type(() => String)
  @IsString()
  @MaxLength(80)
  buscar?: string;
}

/** Directorio público: solo lo publicado. */
export class QueryDirectorioPublicoDto extends PaginationDto {
  /** Slug de la especialidad. */
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9-]{1,80}$/)
  especialidad?: string;
}
