import { fechasDeRepeticion } from './actividades.service';

/**
 * Se corre también con `TZ=America/New_York`, la zona del VPS: ahí es donde
 * `setDate(+7)` movía las series una hora al cambiar EE. UU. de horario.
 */
describe('fechasDeRepeticion', () => {
  const MARTES_10_LA_PAZ = new Date('2026-10-20T14:00:00.000Z');

  it('una serie semanal de los martes 10:00 sigue a las 10:00 de La Paz tras el 1 de noviembre', () => {
    const fechas = fechasDeRepeticion(MARTES_10_LA_PAZ, { frecuencia: 'SEMANAL', veces: 4 });
    expect(fechas.map(f => f.toISOString())).toEqual([
      '2026-10-20T14:00:00.000Z',
      '2026-10-27T14:00:00.000Z',
      '2026-11-03T14:00:00.000Z',
      '2026-11-10T14:00:00.000Z',
    ]);
  });

  it('quincenal y mensual, a la misma hora', () => {
    expect(fechasDeRepeticion(MARTES_10_LA_PAZ, { frecuencia: 'QUINCENAL', veces: 2 })[1].toISOString()).toBe('2026-11-03T14:00:00.000Z');
    expect(fechasDeRepeticion(MARTES_10_LA_PAZ, { frecuencia: 'MENSUAL', veces: 3 }).map(f => f.toISOString())).toEqual([
      '2026-10-20T14:00:00.000Z',
      '2026-11-20T14:00:00.000Z',
      '2026-12-20T14:00:00.000Z',
    ]);
  });

  it('sin repetición, una sola fecha', () => {
    expect(fechasDeRepeticion(MARTES_10_LA_PAZ)).toEqual([MARTES_10_LA_PAZ]);
  });
});
