/**
 * El trozo de URL legible de un título: «Control Prenatal — 2×1» → «control-prenatal-2x1».
 *
 * Sin tildes ni eñes (las URL con ellas se ven como `%C3%B1` al compartirlas),
 * solo `a-z`, `0-9` y guiones simples. Lo usan las promociones y el directorio
 * médico, que la landing enlaza por slug.
 */
export function aSlug(texto: string, largoMaximo = 80): string {
  const base = texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/×/g, 'x')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base.slice(0, largoMaximo).replace(/-+$/g, '') || 'sin-titulo';
}
