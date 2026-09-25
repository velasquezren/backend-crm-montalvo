import { preguntaPorUbicacion } from './ubicacion-clinica';

describe('preguntaPorUbicacion', () => {
  it.each([
    '¿Dónde quedan?',
    'Hola buenas tardes, dónde están?',
    'donde está la clínica',
    '¿Me pasa la ubicación por favor?',
    'Ubicación',
    'pasame la ubi',
    'En qué zona están ubicados?',
    '¿Cuál es la dirección?',
    'Cómo llego a la clínica desde el centro?',
    'me mandan el google maps?',
    'dónde se encuentran',
    'a dónde tengo que ir para la consulta?',
    'DONDE ATIENDEN',
  ])('sí: «%s»', texto => {
    expect(preguntaPorUbicacion(texto)).toBe(true);
  });

  /* Callar es mejor que mandar un pin que nadie pidió. */
  it.each([
    '¿Dónde están mis resultados?',
    '¿Dónde puedo ver mi informe?',
    'Mi dirección es calle Junín 123',
    'Le mando a su dirección de correo',
    '¿Cuánto cuesta la consulta?',
    'Ya estoy en la clínica',
    'Hola, quiero una cita',
    '',
    '👍',
  ])('no: «%s»', texto => {
    expect(preguntaPorUbicacion(texto)).toBe(false);
  });
});
