/**
 * Corta un texto a `max` caracteres con «…» al final, para los límites de Meta.
 * Cuenta caracteres de verdad (puntos de código), no unidades UTF-16: cortar por
 * `slice` puede partir un emoji en dos y dejar un carácter suelto que Meta rechaza.
 */
export function acortar(texto: string, max: number): string {
  const caracteres = Array.from(texto);
  if (caracteres.length <= max) return texto;
  return `${caracteres.slice(0, max - 1).join('').trimEnd()}…`;
}
