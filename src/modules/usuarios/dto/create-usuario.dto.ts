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
   * Las líneas cuyos mensajes NO le suenan: las sigue viendo, pero sin push ni
   * aviso en la pestaña (salvo los chats que sean suyos). Solo líneas que la
   * cuenta puede ver: las de `lineaIds`, o cualquiera si su rol es global.
   *
   * Ausente = se conserva lo que tenía, y eso importa: la propia persona puede
   * cambiarlo desde su perfil, y guardar su ficha en Agentes no debe pisarlo.
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
