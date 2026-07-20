import { EstadoVenta } from '@prisma/client';
import { IsEnum, IsNumber, IsOptional, IsPositive, IsString, IsUUID, MinLength } from 'class-validator';

/** RF-11 — el agente sale del JWT en el servidor, nunca del body (RF-12). */
export class CreateVentaDto {
  @IsUUID()
  clienteId!: string;

  @IsString()
  @MinLength(2)
  producto!: string;

  /** Monto en bolivianos (Bs). */
  @IsNumber()
  @IsPositive()
  monto!: number;

  @IsOptional()
  @IsEnum(EstadoVenta)
  estado?: EstadoVenta;
}
