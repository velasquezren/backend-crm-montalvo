import { TipoActividad } from '../../../prisma/prisma-client';
import { Type } from 'class-transformer';
import {
  IsDate,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

const FRECUENCIAS_REPETICION = ['SEMANAL', 'QUINCENAL', 'MENSUAL'] as const;
export type FrecuenciaRepeticion = (typeof FRECUENCIAS_REPETICION)[number];

/**
 * Repetir al crear: **no** es una serie enlazada — genera `veces` filas
 * independientes, cada una editable/completable por su cuenta, sin
 * `serieId` ni vínculo entre ellas. Mismo criterio de simplicidad que
 * Agenda Médica ("mover una cita de una serie recurrente mueve solo esa"):
 * acá directamente no hay "esta y las siguientes" que resolver, porque no
 * hay serie. Si el día de mañana hace falta editar el patrón completo, eso
 * es una serie enlazada de verdad — no se puede fingir con esto.
 */
export class RepetirActividadDto {
  @IsIn(FRECUENCIAS_REPETICION)
  frecuencia!: FrecuenciaRepeticion;

  /** Total de actividades a crear, incluida la primera. 1 no tendría sentido ("repetir" una vez). */
  @IsInt()
  @Min(2)
  @Max(12)
  veces!: number;
}

/**
 * Alta de un recordatorio/tarea de seguimiento comercial.
 *
 * `agenteId` es opcional y solo tiene efecto si quien la crea es ADMIN+
 * (ver `ActividadesService.create`): un agente normal siempre queda como
 * dueño de lo que crea, no puede agendarle tareas a otra persona.
 */
export class CreateActividadDto {
  @IsEnum(TipoActividad)
  tipo!: TipoActividad;

  @IsString()
  @MinLength(3)
  @MaxLength(200)
  titulo!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notas?: string;

  @Type(() => Date)
  @IsDate()
  fechaProgramada!: Date;

  /**
   * Minutos que dura de verdad — una llamada no es una reunión. Opcional:
   * si no llega, el schema por defecto guarda 30. El frontend manda un valor
   * sugerido por tipo (LLAMADA 15, REUNION 60, TAREA 30, RECORDATORIO 5),
   * que la persona puede cambiar antes de guardar.
   */
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(480)
  duracionMinutos?: number;

  @IsString()
  clienteId!: string;

  /** Lead puntual del pipeline al que se ata, si aplica. */
  @IsOptional()
  @IsString()
  leadId?: string;

  @IsOptional()
  @IsString()
  agenteId?: string;

  /** Solo tiene efecto al crear — ver `RepetirActividadDto`. */
  @IsOptional()
  @ValidateNested()
  @Type(() => RepetirActividadDto)
  repetir?: RepetirActividadDto;
}
