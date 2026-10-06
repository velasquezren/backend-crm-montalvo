import { acortar } from './acortar';

describe('acortar', () => {
  it('deja intacto lo que cabe y corta lo demás con «…»', () => {
    expect(acortar('Vacuna', 24)).toBe('Vacuna');
    expect(acortar('Control prenatal completo con ecografía', 24)).toBe('Control prenatal comple…');
    expect(Array.from(acortar('x'.repeat(100), 24))).toHaveLength(24);
  });

  it('no parte un emoji: cuenta caracteres, no unidades UTF-16', () => {
    const texto = `${'a'.repeat(22)}🙂🙂🙂`;
    const corto = acortar(texto, 24);
    expect(corto).toBe(`${'a'.repeat(22)}🙂…`);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(corto)).toBe(false);
  });
});
