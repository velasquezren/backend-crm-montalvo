import { aSlug } from './slug';

describe('aSlug', () => {
  it.each([
    ['Control Prenatal — 2×1', 'control-prenatal-2x1'],
    ['Dra. María Ñúñez Peña', 'dra-maria-nunez-pena'],
    ['  ¡Promo de Octubre!  ', 'promo-de-octubre'],
    ['Ginecología', 'ginecologia'],
    ['***', 'sin-titulo'],
  ])('«%s» → %s', (texto, slug) => {
    expect(aSlug(texto)).toBe(slug);
  });

  it('respeta el largo sin dejar un guion al final', () => {
    const s = aSlug('palabra '.repeat(40), 20);
    expect(s.length).toBeLessThanOrEqual(20);
    expect(s.endsWith('-')).toBe(false);
  });
});
