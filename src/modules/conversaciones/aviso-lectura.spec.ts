import { debeAvisarLecturaAMeta } from './conversaciones.service';

describe('avisarle a Meta que el chat se leyó', () => {
  const ahora = Date.parse('2026-10-10T16:00:00Z');
  const hace = (ms: number) => new Date(ahora - ms);
  const HORA = 3_600_000;
  const DIA = 24 * HORA;

  it('solo si había algo sin leer: reabrir un chat ya leído no llama a Meta', () => {
    expect(debeAvisarLecturaAMeta({ recienLeidos: 2, typing: false, recibidoEn: hace(HORA) }, ahora)).toBe(true);
    expect(debeAvisarLecturaAMeta({ recienLeidos: 0, typing: false, recibidoEn: hace(HORA) }, ahora)).toBe(false);
  });

  it('un mensaje de más de 30 días ya no existe para Meta: no se le pide', () => {
    expect(debeAvisarLecturaAMeta({ recienLeidos: 1, typing: false, recibidoEn: hace(31 * DIA) }, ahora)).toBe(false);
  });

  it('el «escribiendo…» sale aunque ya estuviera leído, pero solo dentro de las 24 h', () => {
    expect(debeAvisarLecturaAMeta({ recienLeidos: 0, typing: true, recibidoEn: hace(2 * HORA) }, ahora)).toBe(true);
    expect(debeAvisarLecturaAMeta({ recienLeidos: 0, typing: true, recibidoEn: hace(25 * HORA) }, ahora)).toBe(false);
  });
});
