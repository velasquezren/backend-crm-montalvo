import { nombreLimpio } from './espacios';

/*
 * Los casos reproducen los defectos de espaciado REALES de la agenda (90
 * médicos, 15 con espacio de sobra el 2026-10-09) con nombres sintéticos. Se
 * fijan así para que la prueba falle si alguien «simplifica» a un `trim()`,
 * que deja el espacio doble del medio.
 */
describe('nombreLimpio', () => {
  it('quita el espacio del final, que es el caso más común', () => {
    expect(nombreLimpio('Dr. San Roman Pedro ')).toBe('Dr. San Roman Pedro');
    expect(nombreLimpio('Lic. Paola Sintetica Vargas ')).toBe('Lic. Paola Sintetica Vargas');
  });

  it('colapsa el espacio doble del medio: un `trim()` solo no basta', () => {
    expect(nombreLimpio('Dr.  San Roman Pedro')).toBe('Dr. San Roman Pedro');
    expect('Dr.  San Roman Pedro'.trim()).not.toBe('Dr. San Roman Pedro');
  });

  it('un nombre que ya estaba bien no se toca', () => {
    expect(nombreLimpio('Dra. Paola Sintetica')).toBe('Dra. Paola Sintetica');
  });

  it('salto de línea y tabulación también son espacio', () => {
    expect(nombreLimpio('Dra.\tPaola\nSintetica')).toBe('Dra. Paola Sintetica');
  });

  it('una cadena de solo espacios queda vacía, no con un espacio', () => {
    expect(nombreLimpio('   ')).toBe('');
  });
});
