import { CategoriaCliente } from '@prisma/client';
import { IsEmail, IsEnum, IsObject, IsOptional, IsPhoneNumber, IsString, MinLength } from 'class-validator';

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

  /** Campos de un origen externo sin columna dedicada (ej. import FileMaker). */
  @IsOptional()
  @IsObject()
  datosExtra?: Record<string, unknown>;
}
