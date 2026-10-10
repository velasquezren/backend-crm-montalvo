/**
 * Un nombre que se va a mostrar, con los espacios normalizados.
 *
 * Los nombres de la agenda ScriptCase vienen tecleados a mano y 15 de los 90
 * traen espacio de sobra: cinco en medio («Dr.  Iraldo Perez Exposito») y el
 * resto al final («Dr. Carlos Daniel Flores de la Riva »). Armar el nombre
 * público con `[sigla, nombre].join(' ')` arrastra ese espacio a la ficha web,
 * que es una página pública.
 *
 * El `slug` no sufría —`aSlug` colapsa todo lo que no es alfanumérico— así que
 * el defecto solo se veía en el nombre mostrado, que es justo donde se nota.
 */
export function nombreLimpio(texto: string): string {
  return texto.replace(/\s+/g, ' ').trim();
}
