import { escaparComodinesLike, terminoBusqueda } from './busqueda';

/**
 * Un buscador que devuelve de más es peor que uno lento: la agente cree que ya
 * miró y sigue. Estos casos son los que aparecen de verdad en la clínica —
 * descuentos escritos como "20%" y promociones "2x1"— no entradas rebuscadas.
 */
describe('escaparComodinesLike', () => {
  it('escapa el porcentaje, que es lo que se teclea a diario', () => {
    expect(escaparComodinesLike('20%')).toBe('20\\%');
  });

  it('escapa el guion bajo', () => {
    expect(escaparComodinesLike('plan_oro')).toBe('plan\\_oro');
  });

  /* La barra se escapa a sí misma ANTES que el resto: si se hiciera al revés,
     escapar `%` produciría `\%` y una segunda pasada lo convertiría en `\\%`,
     que en LIKE es "barra literal seguida de comodín" — justo lo contrario. */
  it('escapa la barra invertida sin romper lo demás', () => {
    expect(escaparComodinesLike('a\\b')).toBe('a\\\\b');
    expect(escaparComodinesLike('50%\\')).toBe('50\\%\\\\');
  });

  it('deja intacto un término normal', () => {
    expect(escaparComodinesLike('Rinoplastia')).toBe('Rinoplastia');
  });

  /* Sin escapar, este término solo devolvía la tabla entera. */
  it('un comodín suelto deja de ser comodín', () => {
    expect(escaparComodinesLike('%')).toBe('\\%');
  });
});

describe('terminoBusqueda', () => {
  it('recorta y escapa', () => {
    expect(terminoBusqueda('  20%  ')).toBe('20\\%');
  });

  /* `undefined` hace que el `where` omita la condición. Con cadena vacía el
     LIKE sería '%%', o sea todo — que es como un filtro vacío acaba
     devolviendo 15.000 pacientes. */
  it.each([undefined, null, '', '   '])('devuelve undefined para %p', entrada => {
    expect(terminoBusqueda(entrada as string | undefined)).toBeUndefined();
  });
});
