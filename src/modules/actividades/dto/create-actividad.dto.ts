import { TipoActividad } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsDate, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

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

  @IsString()
  clienteId!: string;

  /** Lead puntual del pipeline al que se ata, si aplica. */
  @IsOptional()
  @IsString()
  leadId?: string;

  @IsOptional()
  @IsString()
  agenteId?: string;
}
