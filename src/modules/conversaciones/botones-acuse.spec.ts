import { leerBotones } from './conversaciones.service';

/**
 * Meta rechaza un mensaje interactivo malformado ENTERO: si los botones no
 * cumplen sus reglas, el paciente no recibe nada. Por eso esta función devuelve
 * `null` ante la duda y el acuse cae a texto plano — degradar, nunca fallar.
 */
describe('leerBotones', () => {
  it('lee hasta tres botones separados por |', () => {
    expect(leerBotones('Agendar cita|Resultados|Otra consulta')).toEqual([
      'Agendar cita',
      'Resultados',
      'Otra consulta',
    ]);
  });

  it('limpia espacios y descarta vacíos', () => {
    expect(leerBotones('  Agendar cita | Resultados |  ')).toEqual(['Agendar cita', 'Resultados']);
  });

  it('sin configurar devuelve null (acuse en texto plano)', () => {
    expect(leerBotones(undefined)).toBeNull();
    expect(leerBotones('')).toBeNull();
    expect(leerBotones('   |  | ')).toBeNull();
  });

  /* Los tres límites de Meta. Romperlos deja al paciente sin mensaje. */
  it('rechaza más de tres botones', () => {
    expect(leerBotones('Uno|Dos|Tres|Cuatro')).toBeNull();
  });

  it('rechaza un título de más de 20 caracteres', () => {
    expect(leerBotones('Agendar una cita médica hoy')).toBeNull();
    expect(leerBotones('12345678901234567890')).toHaveLength(1); // 20 justos: pasa
  });

  it('rechaza títulos repetidos', () => {
    expect(leerBotones('Resultados|Resultados')).toBeNull();
  });
});
