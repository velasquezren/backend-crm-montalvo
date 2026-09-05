import { CategoriaCliente } from '@prisma/client';
import {
  IsDateString,
  IsEmail,
  IsEnum,
  IsObject,
  IsOptional,
  IsPhoneNumber,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Entrada validada para crear un cliente — RF-01.
 * `telefono` es el campo de deduplicación (RF-02), único en el schema.
 */
export class CreateClienteDto {
  @IsString()
  @MinLength(2)
  nombre!: string;

  @IsPhoneNumber()
  telefono!: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsEnum(CategoriaCliente)
  categoria?: CategoriaCliente;

  /**
   * `null` admitido a propósito: desasignar es una operación real (devolver el
   * cliente al pool) y hay que poder distinguirla de `undefined`, que en el
   * update significa "no tocar este campo". `@IsOptional()` salta la validación
   * con ambos, y el service decide por `!== undefined`.
   */
  @IsOptional()
  @IsString()
  agenteId?: string | null;

  @IsOptional()
  @IsString()
  empresa?: string;
  /**
   * Fecha de nacimiento (AAAA-MM-DD). Sustituye al antiguo campo `edad`: la
   * edad no se guarda porque caduca sola — se calcula al mostrarla. El volcado
   * de FileMaker tenía edades congeladas con hasta 18 años de desvío.
   */
  @IsOptional()
  @IsDateString()
  fechaNacimiento?: string;

  @IsOptional()
  @IsString()
  lugarNacimiento?: string;

  /**
   * Código de historia clínica en FileMaker (ej. PAC1897 o Pac-1897).
   * Se normaliza siempre a mayúsculas en el service para mantener consistencia.
   */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  pac?: string | null;

  /** Cédula de Identidad del paciente. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  ci?: string | null;

  /** Campos de un origen externo sin columna dedicada (ej. import FileMaker). */
  @IsOptional()
  @IsObject()
  datosExtra?: Record<string, unknown>;
}
