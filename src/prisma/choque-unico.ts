import { Prisma } from './prisma-client';

/**
 * Qué índice único rebotó en un P2002, mirando las DOS formas en que Prisma lo
 * cuenta.
 *
 * `meta.target` es la clásica y la única que documenta Prisma. **Con el driver
 * adapter que usa este proyecto no existe**: el nombre real del índice viaja
 * dentro del error del driver, en `meta.driverAdapterError.cause.constraint`.
 *
 * Mirar solo `target` ya rompió dos cosas sin que nadie se enterara, y por eso
 * esto vive aquí y no dentro de un módulo:
 *
 * - `recuperarEnvioDuplicado` (Conversaciones) no reconocía el choque de
 *   `clientMessageId`, devolvía `null`, y el POST duplicado terminaba en 500 en
 *   vez de devolver la fila que ya existía.
 * - `traducirChoqueUnico` (Clientes) no reconocía ni el teléfono ni el PAC, así
 *   que un número repetido —el caso corriente de recepción— salía como error
 *   crudo de Prisma en vez del 409 que explica de quién es ese número.
 *
 * Ninguno de los dos se vio en pruebas porque las que había ejercitaban el
 * índice directamente contra Prisma, sin pasar por la traducción.
 *
 * Devuelve **candidatos**, no campos: según la forma, un elemento puede ser el
 * nombre de la columna (`telefono`) o el del índice (`Cliente_telefono_key`).
 * Para quedarte con la columna, pasa cada uno por `campoDeIndice`.
 */
export function candidatosDeChoqueUnico(error: Prisma.PrismaClientKnownRequestError): string[] {
  const candidatos: string[] = [];

  const objetivo = error.meta?.['target'];
  if (Array.isArray(objetivo)) candidatos.push(...objetivo.map(String));
  else if (objetivo !== undefined && objetivo !== null) candidatos.push(String(objetivo));

  const driver = error.meta?.['driverAdapterError'] as
    | { cause?: { constraint?: { index?: string; fields?: string[] } } }
    | undefined;
  const constraint = driver?.cause?.constraint;
  if (constraint?.index) candidatos.push(constraint.index);
  if (Array.isArray(constraint?.fields)) candidatos.push(...constraint.fields.map(String));

  return candidatos;
}

/** La tabla donde rebotó, si el driver la dijo. */
export function tablaDelChoque(error: Prisma.PrismaClientKnownRequestError): string | undefined {
  const driver = error.meta?.['driverAdapterError'] as { cause?: { table?: string } } | undefined;
  const tabla = driver?.cause?.table;
  return typeof tabla === 'string' && tabla ? tabla : undefined;
}

/**
 * La columna que hay detrás del nombre de un índice de Postgres:
 * `Cliente_telefono_key` → `telefono`.
 *
 * Quitar la tabla exige conocerla —es lo que evita que `Cliente_ci_key` se
 * quede en `ci_key` o que un índice de otra tabla se recorte mal—, así que sin
 * ella el candidato se devuelve tal cual: es mejor no reconocer el campo que
 * reconocer el equivocado y señalar la casilla de al lado.
 */
export function campoDeIndice(candidato: string, tabla?: string): string {
  const sinSufijo = candidato.replace(/_(key|unique)$/, '');
  const prefijo = tabla ? `${tabla}_` : '';
  return prefijo && sinSufijo.startsWith(prefijo) ? sinSufijo.slice(prefijo.length) : sinSufijo;
}

/**
 * ¿El error es un P2002 sobre `campo` de `tabla`? La forma corta de las tres de
 * arriba para el caso corriente: «si chocó el slug, pruebo con otro; si chocó
 * otra cosa, que suba».
 */
export function esChoqueUnicoEn(error: unknown, tabla: string, campo: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false;
  return candidatosDeChoqueUnico(error).some(c => campoDeIndice(c, tabla) === campo);
}
