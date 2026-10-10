import { nombreLimpio } from './espacios';

/*
 * Los casos son nombres REALES de la agenda (90 médicos, 15 con espacio de
 * sobra el 2026-10-10). Se fijan así para que la prueba falle si alguien
 * «simplifica» a un `trim()`, que deja el espacio doble del medio.
 */
describe('nombreLimpio', () => {
  it('quita el espacio del final, que es el caso más común', () => {
    expect(nombreLimpio('Dr. Carlos Daniel Flores de la Riva ')).toBe('Dr. Carlos Daniel Flores de la Riva');
    expect(nombreLimpio('Lic. Laura Ximena Angulo Montalvo ')).toBe('Lic. Laura Ximena Angulo Montalvo');
  });

  it('colapsa el espacio doble del medio: un `trim()` solo no basta', () => {
    expect(nombreLimpio('Dr.  Iraldo Perez Exposito')).toBe('Dr. Iraldo Perez Exposito');
    expect('Dr.  Iraldo Perez Exposito'.trim()).not.toBe('Dr. Iraldo Perez Exposito');
  });

  it('un nombre que ya estaba bien no se toca', () => {
    expect(nombreLimpio('Dra. Ana Karina Torrico Espinoza')).toBe('Dra. Ana Karina Torrico Espinoza');
  });

  it('salto de línea y tabulación también son espacio', () => {
    expect(nombreLimpio('Dra.\tVirna\nSeveriche')).toBe('Dra. Virna Severiche');
  });

  it('una cadena de solo espacios queda vacía, no con un espacio', () => {
    expect(nombreLimpio('   ')).toBe('');
  });
});
