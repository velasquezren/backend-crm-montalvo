import { CategoriaCliente, Prisma } from '../../prisma/prisma-client';

/*
 * Cuánto vale una paciente: la regla de Gold / Silver / Bronze / Prospecto.
 *
 * Mide el VALOR (lo que gastó y cuándo), no si conviene escribirle ahora: eso
 * —baja de promociones, si lee, si recibió otra campaña hace poco— es otra
 * pregunta y no se mezcla aquí.
 *
 * Hasta el 2026-09-30 se calculaba solo con las ventas registradas en el CRM
 * (22 en total), así que 16.294 de 16.318 fichas eran Prospecto y la categoría
 * no servía para decidir nada. Ahora suma también las ventas de FileMaker
 * (`VentaImportada`, 2.368 filas de enero a junio de 2026) tal como se
 * importan: los paquetes y su precio se toman como vienen.
 *
 * Los umbrales salen de esos datos: en seis meses, la mitad de las pacientes
 * gastó $226 o menos, el 25 % superior más de $2.511 y el 10 % superior más de
 * $3.545 —ese 10 % concentra el 41 % de la facturación—. Gold es, a propósito,
 * ese grupo. Los fijó el propietario el 2026-09-30.
 */

/** Gasto en dólares en la ventana que hace Gold (≈ el 10 % que más gasta). */
export const UMBRAL_GOLD_USD = 3_500;
/** Gasto en dólares en la ventana que hace Silver. */
export const UMBRAL_SILVER_USD = 1_000;
/** La ventana del gasto: los últimos 12 meses. */
export const VENTANA_DIAS = 365;

/** Lo que el cálculo necesita saber de una paciente. */
export interface ValorPaciente {
  /** Dólares gastados dentro de la ventana, sumando FileMaker y el CRM. */
  readonly gastoRecienteUsd: number;
  /** Compras pagadas de toda la historia, de las dos fuentes. */
  readonly compras: number;
}

/**
 * La regla, en un solo sitio. El SQL solo agrega los números; quién es Gold
 * lo decide esta función, para que la regla no viva escrita dos veces.
 *
 *   Gold      gastó ≥ $3.500 en los últimos 12 meses
 *   Silver    gastó ≥ $1.000 en los últimos 12 meses
 *   Bronze    compró alguna vez, pero menos o hace más de 12 meses
 *   Prospecto nunca compró
 */
export function categoriaPorValor({ gastoRecienteUsd, compras }: ValorPaciente): CategoriaCliente {
  if (gastoRecienteUsd >= UMBRAL_GOLD_USD) return CategoriaCliente.GOLD;
  if (gastoRecienteUsd >= UMBRAL_SILVER_USD) return CategoriaCliente.SILVER;
  if (compras > 0) return CategoriaCliente.BRONZE;
  return CategoriaCliente.PROSPECTO;
}

/** El comienzo de la ventana de gasto. */
export function inicioDeVentana(ahora: Date): Date {
  return new Date(ahora.getTime() - VENTANA_DIAS * 24 * 60 * 60 * 1000);
}

/**
 * Las dos CTE que agregan el valor de cada paciente, para usar tras un `WITH`:
 *
 *  - `filemaker` por `pac`: lo importado de FileMaker, en dólares y tal como
 *    viene; solo cuentan las líneas con precio.
 *  - `crm` por `clienteId`: las ventas GANADAS del CRM, de Bs a dólares con
 *    el tipo de cambio que se le pasa.
 *
 * Cada una da `reciente` (gasto en la ventana), `compras` y `ultima` (fecha
 * de la última compra). La comparten la categoría y Audiencias: si cada uno
 * sumara a su manera, una paciente Gold en su ficha podría no serlo en una
 * audiencia.
 */
export function valorDePacientesSql(desde: Date, tipoCambio: number): Prisma.Sql {
  return Prisma.sql`
    filemaker AS (
      SELECT v.pac,
             SUM(v.precio) FILTER (WHERE v.fecha >= ${desde}) AS reciente,
             COUNT(*) AS compras,
             MAX(v.fecha) AS ultima
      FROM "VentaImportada" v
      WHERE v.pac IS NOT NULL AND v.precio > 0
      GROUP BY v.pac
    ), crm AS (
      SELECT "clienteId",
             SUM(monto) FILTER (WHERE "createdAt" >= ${desde}) / ${tipoCambio} AS reciente,
             COUNT(*) AS compras,
             MAX("createdAt") AS ultima
      FROM "Venta"
      WHERE estado = 'GANADA'
      GROUP BY "clienteId"
    )`;
}
