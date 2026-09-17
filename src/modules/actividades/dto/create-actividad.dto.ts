import { FrecuenciaRepeticion, TipoActividad } from '../../../prisma/prisma-client';
import { Type } from 'class-transformer';
import {
  IsDate,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/**
 * Repetir al crear: genera `veces` ocurrencias que comparten `serieId`.
 *
 * **Qué cambió y por qué.** Antes eran filas sueltas, sin vínculo, y este
 * mismo comentario defendía esa simplicidad. La decisión se revisó al
 * comprobar el coste real: desde una ocurrencia no había forma de saber
 * cuáles eran sus hermanas —ni siquiera adivinando por cliente y título, que
 * confunde homónimas—, así que mover un seguimiento semanal de hora eran doce
 * ediciones a mano.
 *
 * Lo que se añade es identidad, no un motor de recurrencias: no se guarda el
 * patrón ni se regeneran ocurrencias. Cada una sigue siendo una Actividad
 * real, editable y completable por su cuenta; lo único que ahora se puede es
 * aplicar algo a «esta y las siguientes».
 */
export class RepetirActividadDto {
  @IsEnum(FrecuenciaRepeticion)
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
