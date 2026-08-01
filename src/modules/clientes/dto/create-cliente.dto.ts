import { CategoriaCliente } from '@prisma/client';
import { IsEmail, IsEnum, IsObject, IsOptional, IsPhoneNumber, IsString, MinLength, IsDateString} from 'class-validator';

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

  @IsOptional()
  @IsString()
  agenteId?: string;

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

  /** Campos de un origen externo sin columna dedicada (ej. import FileMaker). */
  @IsOptional()
  @IsObject()
  datosExtra?: Record<string, unknown>;
}
