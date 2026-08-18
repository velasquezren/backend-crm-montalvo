/**
 * Neutraliza los comodines de LIKE en un término escrito por una persona.
 *
 * **Prisma traduce `contains` a `LIKE '%término%'` sin escapar nada**: lo que
 * teclea la agente llega crudo al patrón. Buscar `%` devuelve la tabla entera, y
 * `20%` —que en esta clínica se escribe todo el día, entre descuentos y
 * promociones— hace match con cualquier fila que contenga "20". `_` es igual de
 * comodín, y comerse una barra invertida rompería el patrón.
 *
 * Postgres usa `\` como escape por defecto en LIKE. La barra va primero en la
 * clase de caracteres a propósito: se escapa a sí misma antes que al resto.
 *
 * Vive en `common/` y no en un módulo porque el fallo no es de un buscador: es
 * de todos. Se arregló primero solo en la búsqueda de mensajes, y los otros
 * ocho `contains` del backend —pacientes, ventas de la planilla, memoria del
 * agente— siguieron mintiendo. Un buscador que dice "no existe" a algo que sí
 * existe es peor que uno lento.
 */
export function escaparComodinesLike(termino: string): string {
  return termino.replace(/[\\%_]/g, caracter => `\\${caracter}`);
}

/**
 * Prepara un término de búsqueda: recorta, y devuelve `undefined` si no queda
 * nada que buscar — así el `where` puede omitir la condición en vez de filtrar
 * por cadena vacía, que en LIKE equivale a "todo".
 */
export function terminoBusqueda(entrada: string | undefined | null): string | undefined {
  const limpio = (entrada ?? '').trim();
  return limpio ? escaparComodinesLike(limpio) : undefined;
}
