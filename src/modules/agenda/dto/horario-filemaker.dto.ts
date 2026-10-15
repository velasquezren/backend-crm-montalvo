import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { CODIGO_MEDICO_AGENDA, ESTADOS_MEDICO_AGENDA, EstadoMedicoAgenda } from '../agenda-admin.sql';
import { DIAS_AGENDA, DiaAgenda } from '../horario-html';

export class DiaHorarioFilemakerDto {
  @IsIn(DIAS_AGENDA) dia!: DiaAgenda;
  /** Vacío = sin tramo. La hora final es el INICIO de la última consulta. */
  @IsString() @Matches(/^(|(?:[01]\d|2[0-3]):[0-5]\d)$/) mananaInicio!: string;
  @IsString() @Matches(/^(|(?:[01]\d|2[0-3]):[0-5]\d)$/) mananaUltima!: string;
  @IsString() @Matches(/^(|(?:[01]\d|2[0-3]):[0-5]\d)$/) tardeInicio!: string;
  @IsString() @Matches(/^(|(?:[01]\d|2[0-3]):[0-5]\d)$/) tardeUltima!: string;
}

/** Una instantánea completa; nunca se interpreta un día omitido como un día vacío. */
export class HorarioFilemakerDto {
  @IsString() @MinLength(1) @MaxLength(80) registroId!: string;
  @IsString() @Matches(CODIGO_MEDICO_AGENDA) medicoCodigo!: string;
  @IsInt() @Min(1) @Max(2147483647) revision!: number;
  @IsIn(ESTADOS_MEDICO_AGENDA) estado!: EstadoMedicoAgenda;
  @IsString() @MaxLength(100) sucursal!: string;
  @IsInt() @IsIn([30]) minutosConsulta!: number;
  @IsArray() @ArrayMinSize(6) @ArrayMaxSize(6) @ValidateNested({ each: true }) @Type(() => DiaHorarioFilemakerDto)
  dias!: DiaHorarioFilemakerDto[];
}
