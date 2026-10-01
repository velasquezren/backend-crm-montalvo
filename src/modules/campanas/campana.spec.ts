import { dentroDeHorario, nombreDePila, parametrosPara } from './campana';

describe('campaña', () => {
  it('saluda por el nombre de pila, bien escrito', () => {
    expect(nombreDePila('MARÍA JOSÉ Gutiérrez')).toBe('María');
    expect(nombreDePila('  ana  ')).toBe('Ana');
  });

  /* «Hola WhatsApp» es peor que no nombrarla. */
  it('un contacto sin nombre usa el respaldo', () => {
    expect(nombreDePila('WhatsApp +59171234567')).toBeNull();
    expect(parametrosPara([{ tipo: 'NOMBRE', respaldo: 'hola' }], 'WhatsApp +59171234567')).toEqual(['hola']);
  });

  it('arma los parámetros en el orden de la plantilla', () => {
    expect(
      parametrosPara([{ tipo: 'NOMBRE', respaldo: 'hola' }, { tipo: 'TEXTO', texto: ' 20 % en ecografías ' }], 'ana pérez'),
    ).toEqual(['Ana', '20 % en ecografías']);
  });

  /* La Paz es UTC−4 todo el año. */
  it('solo manda de 9:00 a 19:59 en La Paz', () => {
    expect(dentroDeHorario(new Date('2026-10-01T12:59:00Z'))).toBe(false); // 8:59
    expect(dentroDeHorario(new Date('2026-10-01T13:00:00Z'))).toBe(true); // 9:00
    expect(dentroDeHorario(new Date('2026-10-01T23:59:00Z'))).toBe(true); // 19:59
    expect(dentroDeHorario(new Date('2026-10-02T00:00:00Z'))).toBe(false); // 20:00
  });
});
