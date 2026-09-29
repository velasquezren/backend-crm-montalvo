import { Rol } from '../../../prisma/prisma-client';
import { ArrayMaxSize, ArrayUnique, IsArray, IsUUID, IsEmail, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateUsuarioDto {
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  lineaIds?: string[];

  /**
   * Las líneas asignadas cuyos mensajes NO le suenan: los sigue viendo, pero
   * sin push ni aviso en la pestaña (salvo los chats que sean suyos). Tiene
   * que ser un subconjunto de sus líneas.
   *
   * Ausente = se conserva lo que tenía. Por eso no basta con `lineaIds`: la
   * edición reescribe los accesos, y sin este campo cada vez que un admin
   * guardara la ficha le volverían a sonar las líneas que había silenciado.
   */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  lineasSilenciadas?: string[];

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
