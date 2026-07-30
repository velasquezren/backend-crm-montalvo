import { Rol } from '@prisma/client';
import { IsEmail, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateUsuarioDto {
  @IsString()
  @MinLength(2)
  nombre!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsOptional()
  @IsEnum(Rol)
  rol?: Rol;

  /**
   * Identificador que usa la empresa para esta persona (el `vendedora_pk` de
   * FileMaker, ej. Pe2455). Es lo que cruza al agente con sus ventas en la
   * planilla de comisiones, sin depender de cómo esté escrito el nombre.
   */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  codigo?: string;
}
