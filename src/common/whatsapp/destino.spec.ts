import { campoDestino, destinoWhatsapp, esBsuid, normalizarBsuid, telefonoDeDestino } from './destino';

describe('destino de WhatsApp (teléfono o BSUID)', () => {
  it('reconoce el BSUID de Meta y el padre de un portafolio', () => {
    expect(esBsuid('BO.13491208655302741918')).toBe(true);
    expect(esBsuid('US.ENT.11815799212886844830')).toBe(true);
    expect(esBsuid(`BO.${'a1'.repeat(64)}`)).toBe(true);
  });

  it('no confunde un teléfono, ni un BSUID recortado, con un BSUID', () => {
    for (const valor of ['+59170012345', '59170012345', '13491208655302741918', 'bo.123', 'BO.', 'BO.12 34', `BO.${'a'.repeat(129)}`, '', null, undefined]) {
      expect(esBsuid(valor)).toBe(false);
    }
  });

  it('normaliza solo espacios: Meta exige el valor entero', () => {
    expect(normalizarBsuid('  BO.123abc  ')).toBe('BO.123abc');
    expect(normalizarBsuid('+59170012345')).toBeNull();
  });

  it('prefiere el teléfono: es lo que mantiene llegando el número en los webhooks', () => {
    expect(destinoWhatsapp({ telefono: '+59170012345', waUsuarioId: 'BO.1' })).toBe('+59170012345');
    expect(destinoWhatsapp({ telefono: null, waUsuarioId: 'BO.1' })).toBe('BO.1');
    expect(() => destinoWhatsapp({ telefono: null, waUsuarioId: null })).toThrow();
  });

  it('lo que exige un número no recibe nunca un BSUID', () => {
    expect(telefonoDeDestino('+59170012345')).toBe('+59170012345');
    expect(telefonoDeDestino('BO.13491208655302741918')).toBeNull();
  });

  it('traduce al campo de la Cloud API', () => {
    expect(campoDestino('+591 700-12345')).toEqual({ to: '59170012345' });
    expect(campoDestino('BO.13491208655302741918')).toEqual({ recipient: 'BO.13491208655302741918' });
  });
});
