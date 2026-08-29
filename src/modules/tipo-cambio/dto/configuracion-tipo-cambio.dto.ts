import { Type } from 'class-transformer';
import { IsEnum, IsNumber, IsOptional, Max, Min } from 'class-validator';

import { ModoTipoCambio } from '@prisma/client';

/**
 * Cambia el criterio con el que TODO el CRM convierte entre Bs y dólares.
 *
 * Los dos campos son opcionales para poder tocar uno sin reenviar el otro:
 * subir el valor pactado sin salir del modo fijo es lo más habitual.
 */
export class ActualizarConfiguracionTipoCambioDto {
  @IsOptional()
  @IsEnum(ModoTipoCambio)
  modo?: ModoTipoCambio;

  /**
   * `@Type` no es opcional: es un `Decimal` de Prisma y vuelve como TEXTO en el
   * JSON de lectura. Sin la conversión, `@IsNumber()` rechaza lo que la propia
   * pantalla acaba de recibir — el mismo fallo que tuvo `sueldoBase` y que dejó
   * toda una columna de la planilla en cero.
   */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  /* Cotas de cordura, no de negocio: un 0 dividiría por cero al pasar a dólares
     y un valor de tres cifras solo puede ser un dedazo. */
  @Min(0.01)
  @Max(999)
  valorFijo?: number;
}
