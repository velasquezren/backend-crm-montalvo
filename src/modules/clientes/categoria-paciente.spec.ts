import { categoriaPorValor, UMBRAL_GOLD_USD, UMBRAL_SILVER_USD } from './categoria-paciente';

describe('categoriaPorValor', () => {
  it.each([
    [UMBRAL_GOLD_USD, 1, 'GOLD'],
    [UMBRAL_GOLD_USD - 0.01, 9, 'SILVER'],
    [UMBRAL_SILVER_USD, 1, 'SILVER'],
    [UMBRAL_SILVER_USD - 0.01, 1, 'BRONZE'],
    /* Compró hace más de 12 meses: nada en la ventana, pero ya es paciente. */
    [0, 3, 'BRONZE'],
    [0, 0, 'PROSPECTO'],
  ])('$%s en la ventana y %s compras → %s', (gastoRecienteUsd, compras, esperada) => {
    expect(categoriaPorValor({ gastoRecienteUsd, compras })).toBe(esperada);
  });

  /* Muchas compras chicas no hacen Gold: la regla es el gasto, no la frecuencia. */
  it('la cantidad de compras no sube de categoría por sí sola', () => {
    expect(categoriaPorValor({ gastoRecienteUsd: 900, compras: 40 })).toBe('BRONZE');
  });
});
