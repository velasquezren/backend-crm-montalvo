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

/* `modulo` ya no lo teclea ni lo elige nadie: viene del catálogo
   (`GET /ventas/catalogo`), que lo lee de `VentaImportada`. O sea que sus
   valores son los de FileMaker —hoy LABORATORIO, CONSULTA, PLANES,
   INTERNACION— y no una lista nuestra.

   Por eso aquí NO va un `@IsIn`: el día que la clínica abra un módulo nuevo en
   FileMaker, el catálogo lo ofrecería y esta lista lo rechazaría, dejando a la
   agente sin poder registrar esa venta y sin entender por qué. La consistencia
   la garantiza que el catálogo sea la única fuente, no un segundo listado aquí
   que hay que acordarse de actualizar. */

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
  @IsString()
  @MaxLength(60)
  modulo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notas?: string;

  /**
   * Lead que originó esta venta, si el agente lo indicó. El service valida
   * que pertenezca al mismo `clienteId` — un UUID de un lead ajeno no cuela
   * en silencio, se rechaza con 400.
   */
  @IsOptional()
  @IsUUID()
  leadId?: string;

  /**
   * Solo tiene sentido si `estado = PERDIDA` (una venta puede registrarse
   * directamente en ese estado, aunque hoy el formulario del CRM no lo haga).
   * Mismo criterio que `Lead.motivoPerdida`.
   */
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  motivoPerdida?: string;
}
