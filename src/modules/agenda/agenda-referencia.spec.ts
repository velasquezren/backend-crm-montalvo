import { firmarReferencia, leerReferencia } from './agenda-referencia';

describe('referencia firmada del pago de una reserva', () => {
  const secreto = 'secreto-sintetico-de-al-menos-32-caracteres';
  const ahora = Date.UTC(2026, 9, 7, 12);

  it('se lee con el mismo secreto mientras está vigente', () => {
    expect(leerReferencia(firmarReferencia(42, secreto, ahora), secreto, ahora + 60_000)).toBe(42);
  });
  it('vence a las 6 horas', () => {
    expect(leerReferencia(firmarReferencia(42, secreto, ahora), secreto, ahora + 6 * 3600_000 + 1000)).toBeNull();
  });
  it('no sirve con otro id, otro vencimiento, otro secreto ni basura', () => {
    const [, vence, firma] = firmarReferencia(42, secreto, ahora).split('.');
    expect(leerReferencia(`43.${vence}.${firma}`, secreto, ahora)).toBeNull();
    expect(leerReferencia(`42.${Number(vence) + 999}.${firma}`, secreto, ahora)).toBeNull();
    expect(leerReferencia(firmarReferencia(42, 'otro-secreto-distinto-de-32-caracteres', ahora), secreto, ahora)).toBeNull();
    for (const basura of ['', '42', '42..', 'a.b.c', `-1.${vence}.${firma}`]) expect(leerReferencia(basura, secreto, ahora)).toBeNull();
  });
});
