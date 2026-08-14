import { EstadoVenta } from '@prisma/client';
import {
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Formas de pago que acepta la clínica.
 *
 * Es una lista cerrada porque la interfaz la pinta como píldoras y la tabla la
 * muestra como etiqueta: sin restringirla, "QR", "qr", "Qr" y "Pago QR" acaban
 * siendo cuatro métodos distintos y cualquier recuento posterior miente. Hoy
 * `Venta` está vacía, así que promover esto a un enum de Prisma —que es como el
 * proyecto declara los valores cerrados y como llegan tipados al frontend— sale
 * gratis; con datos dentro, ya no.
 */
export const METODOS_PAGO = ['QR', 'TRANSFERENCIA', 'TARJETA', 'EFECTIVO'] as const;

/**
 * Especialidades de Montalvo. Misma razón que arriba para cerrarla.
 *
 * Los identificadores son EXACTAMENTE los de `MODULOS_MONTALVO` en
 * `ventas.page.ts`, que es quien los emite. Si aquí se pusieran los nombres
 * "bonitos" —CIRUGIA_PLASTICA en vez de CIRUGIA— el formulario dejaría de
 * guardar sin decir por qué.
 */
export const MODULOS_CLINICA = [
  'CIRUGIA',
  'ESTETICA',
  'DERMATOLOGIA',
  'MATERNIDAD',
  'GINECOLOGIA',
  'CONSULTA',
  'LABORATORIO',
  'OTRO',
] as const;

/** RF-11 — el agente sale del JWT en el servidor, nunca del body (RF-12). */
export class CreateVentaDto {
  @IsUUID()
  clienteId!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(160)
  producto!: string;

  /** Monto en bolivianos (Bs). */
  @IsNumber()
  @IsPositive()
  monto!: number;

  @IsOptional()
  @IsEnum(EstadoVenta)
  estado?: EstadoVenta;

  @IsOptional()
  @IsIn(METODOS_PAGO)
  metodoPago?: string;

  /* Los `MaxLength` no son decorativos: cada uno es el ancho real de su columna
     (`@db.VarChar`). Sin ellos, un texto más largo no se rechaza con un 400
     explicando qué pasa — pasa la validación, llega a Postgres y vuelve como un
     500 sin explicación para la agente. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  comprobante?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  comprobanteKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  comprobanteMime?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  comprobanteNombre?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  medico?: string;

  @IsOptional()
  @IsIn(MODULOS_CLINICA)
  modulo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notas?: string;
}
