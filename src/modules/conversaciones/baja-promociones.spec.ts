import { esPedidoDeBaja } from './baja-promociones';

/**
 * Qué texto de botón es una baja. Que sea un TOQUE y no algo escrito lo decide
 * el webhook; esto solo reconoce el texto del botón.
 */
describe('esPedidoDeBaja', () => {
  it('reconoce los botones de baja, escritos como vengan', () => {
    for (const texto of ['No me interesa', 'no me interesa', '  NO ME INTERESA ', 'Baja', 'baja']) {
      expect(esPedidoDeBaja(texto)).toBe(true);
    }
  });

  /* «Agendar consulta» es el otro botón de la misma plantilla: confundirlo
     daría de baja a quien quiere una cita. */
  it('no confunde los otros botones ni frases parecidas', () => {
    for (const texto of ['Agendar consulta', 'Me interesa', 'no me interesa esa fecha', 'quiero bajar de peso', '']) {
      expect(esPedidoDeBaja(texto)).toBe(false);
    }
  });
});
