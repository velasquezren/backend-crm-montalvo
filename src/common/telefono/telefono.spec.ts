import { normalizarTelefono } from './telefono';

describe('normalizarTelefono', () => {
  it('deja en E.164 lo que la agente escribe a mano', () => {
    expect(normalizarTelefono('70012345')).toBe('+59170012345');
    expect(normalizarTelefono('+591 700-12-345')).toBe('+59170012345');
    expect(normalizarTelefono('59170012345')).toBe('+59170012345');
    expect(normalizarTelefono('00591 70012345')).toBe('+59170012345');
  });

  it('respeta otros países y lo que llega del webhook', () => {
    expect(normalizarTelefono('+34 612 345 678')).toBe('+34612345678');
    expect(normalizarTelefono('+5215512345678')).toBe('+5215512345678');
  });

  it('rechaza lo que no es un teléfono', () => {
    expect(normalizarTelefono('123')).toBeNull();
    expect(normalizarTelefono('')).toBeNull();
    expect(normalizarTelefono(null)).toBeNull();
  });
});
