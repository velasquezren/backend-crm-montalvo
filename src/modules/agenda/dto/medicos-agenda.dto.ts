import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
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
import { CODIGO_MEDICO_AGENDA, ESTADOS_MEDICO_AGENDA, EstadoMedicoAgenda } from '../agenda-admin.sql';
import { DIAS_AGENDA, DiaAgenda } from '../horario-html';

const recortar = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
/** Texto opcional: vacío equivale a no tenerlo. */
const recortarONulo = ({ value }: { value: unknown }) => {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value.trim() || null : value;
};

/** La huella de la ficha que se leyó (`FichaMedicoAgenda.version`). */
const VERSION_FICHA = /^[0-9a-f]{16}$/;

/** Filtros del listado de médicos de la agenda. */
export class QueryMedicosAgendaAdminDto extends PaginationDto {
  @IsOptional() @IsString() @MaxLength(60)
  buscar?: string;

  @IsOptional() @IsString() @MaxLength(200)
  especialidad?: string;

  @IsOptional() @IsIn(ESTADOS_MEDICO_AGENDA)
  estado?: EstadoMedicoAgenda;
}

/**
 * Los datos de un médico que se editan desde el CRM. Los largos son los de las
 * columnas de `medicos` en producción (`sigla` VARCHAR(5), `telefono` VARCHAR(50)…).
 */
export class DatosMedicoAgendaDto {
  @Transform(recortar) @IsString() @IsNotEmpty() @MaxLength(200)
  nombre!: string;

  /** «Dr.», «Dra.», «Lic.». */
  @Transform(recortarONulo) @IsOptional() @IsString() @MaxLength(5)
  sigla!: string | null;

  @Transform(recortar) @IsString() @IsNotEmpty() @MaxLength(200)
  especialidad!: string;

  @Transform(recortarONulo) @IsOptional() @IsString() @MaxLength(50)
  telefono!: string | null;

  @IsIn(ESTADOS_MEDICO_AGENDA)
  estado!: EstadoMedicoAgenda;

  /** En Bs, con hasta dos decimales: «400» o «400.50». Null = sin precio. */
  @Transform(recortarONulo) @IsOptional() @IsString() @Matches(/^\d{1,8}(\.\d{1,2})?$/, { message: 'El precio va en bolivianos, con hasta dos decimales.' })
  precio!: string | null;

  /** `pagos_qr.qr_pk` del QR con que se cobra. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  bancoId!: number | null;

  @Type(() => Number) @IsInt() @Min(0) @Max(9999)
  orden!: number;
}

export class ActualizarMedicoAgendaDto extends DatosMedicoAgendaDto {
  @IsString() @Matches(VERSION_FICHA)
  version!: string;
}

export class CrearMedicoAgendaDto extends DatosMedicoAgendaDto {
  /** Código de FileMaker del médico: el mismo que usa la clínica en FileMaker y en `agenda_med`. */
  @Transform(recortar) @IsString() @Matches(CODIGO_MEDICO_AGENDA, { message: 'El código de FileMaker tiene hasta 20 letras, números, espacios, puntos o guiones.' })
  codigo!: string;
}

export class CasillaHorarioDto {
  @IsIn(DIAS_AGENDA)
  dia!: DiaAgenda;

  @IsString() @Matches(/^\d{2}:\d{2}$/)
  hora!: string;
}

/** Las casillas que quedan ENCENDIDAS; las demás se apagan. */
export class GuardarHorarioAgendaDto {
  @IsString() @Matches(VERSION_FICHA)
  version!: string;

  @IsArray() @ArrayMaxSize(6 * 48) @ValidateNested({ each: true }) @Type(() => CasillaHorarioDto)
  activas!: CasillaHorarioDto[];
}

export class RenombrarEspecialidadAgendaDto {
  @Transform(recortar) @IsString() @IsNotEmpty() @MaxLength(200)
  actual!: string;

  @Transform(recortar) @IsString() @IsNotEmpty() @MaxLength(200)
  nueva!: string;
}

/**
 * La presentación web de un médico de la agenda: lo que la agenda no tiene.
 * Nombre de la agenda, precio y horario NO van aquí: los da la agenda.
 */
export class ActualizarPresentacionAgendaDto {
  @Type(() => Number) @IsInt() @Min(1)
  version!: number;

  @IsOptional() @Transform(recortar) @IsString() @MinLength(3) @MaxLength(120)
  nombrePublico?: string;

  @IsOptional() @Transform(recortar) @IsString() @MaxLength(300)
  resumen?: string;

  @IsOptional() @Transform(recortar) @IsString() @MaxLength(3000)
  biografia?: string;

  @IsOptional() @Transform(recortarONulo) @IsString() @MaxLength(40)
  matricula?: string | null;

  @IsOptional() @IsArray() @ArrayMaxSize(10) @ArrayUnique() @IsUUID('all', { each: true })
  especialidadIds?: string[];
}

export class PublicarPresentacionAgendaDto {
  @IsBoolean()
  publicado!: boolean;
}

export class CrearPaginasEspecialidadDto {
  @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) @MaxLength(200, { each: true })
  nombres!: string[];
}

/** La página web de una especialidad: el nombre no va, lo pone la agenda. */
export class ActualizarPaginaEspecialidadDto {
  @IsOptional() @Transform(recortar) @IsString() @MaxLength(600)
  descripcion?: string;

  @IsOptional() @IsBoolean()
  activa?: boolean;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(9999)
  orden?: number;
}
