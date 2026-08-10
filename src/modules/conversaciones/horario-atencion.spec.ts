import { estaAtendiendo, parsearHorario, ZONA_POR_DEFECTO } from './horario-atencion';

/**
 * De esta función depende que un paciente reciba "estamos cerrados" o no reciba
 * nada. Equivocarse aquí no da error: da un mensaje raro a alguien que escribió
 * un martes por la mañana, o silencio un domingo. Por eso se fijan los bordes.
 *
 * Las fechas van en UTC a propósito, para que se vea la conversión: Bolivia es
 * UTC−4, así que las 12:00 UTC son las 08:00 en la clínica.
 */

const HORARIO = parsearHorario('L-V:08:00-18:00,S:08:00-12:00')!;

/** Una fecha UTC, para no depender de la zona de la máquina que corre las pruebas. */
const utc = (iso: string) => new Date(`${iso}Z`);

describe('parsearHorario', () => {
  it('entiende un rango de días y un día suelto', () => {
    const h = parsearHorario('L-V:08:00-18:00,S:08:00-12:00');
    expect(h?.tramos).toHaveLength(6); // lunes a viernes + sábado
    expect(h?.zona).toBe(ZONA_POR_DEFECTO);
  });

  /* Un horario mal escrito debe DESACTIVAR la automatización, no adivinar: es
     preferible no contestar a contestar "estamos cerrados" en pleno horario. */
  it('devuelve null ante cualquier cosa que no entienda', () => {
    for (const malo of [
      '',
      '   ',
      'L-V',                  // sin horas
      'L-V:08:00',            // sin hora de fin
      'Z:08:00-18:00',        // día inexistente
      'V-L:08:00-18:00',      // rango invertido
      'L-V:18:00-08:00',      // fin antes que inicio
      'L-V:25:00-26:00',      // hora imposible
      'L-V:8-18',             // formato sin minutos
    ]) {
      expect(parsearHorario(malo)).toBeNull();
    }
  });

  it('acepta que no se configure nada', () => {
    expect(parsearHorario(undefined)).toBeNull();
  });
});

describe('estaAtendiendo', () => {
  it('un martes a media mañana está abierto', () => {
    // 2026-08-11 es martes. 14:00 UTC = 10:00 en Bolivia.
    expect(estaAtendiendo(utc('2026-08-11T14:00:00'), HORARIO)).toBe(true);
  });

  it('un domingo está cerrado a cualquier hora', () => {
    expect(estaAtendiendo(utc('2026-08-09T14:00:00'), HORARIO)).toBe(false);
    expect(estaAtendiendo(utc('2026-08-09T23:00:00'), HORARIO)).toBe(false);
  });

  it('el sábado cierra a mediodía', () => {
    // 2026-08-15 es sábado. 15:00 UTC = 11:00 local → abierto.
    expect(estaAtendiendo(utc('2026-08-15T15:00:00'), HORARIO)).toBe(true);
    // 17:00 UTC = 13:00 local → ya cerrado.
    expect(estaAtendiendo(utc('2026-08-15T17:00:00'), HORARIO)).toBe(false);
  });

  /* Los bordes exactos: el minuto de apertura cuenta como abierto y el de cierre
     como cerrado. Sin fijarlo, un mensaje a las 18:00 en punto queda en tierra
     de nadie. */
  it('abre en el minuto de inicio y cierra en el de fin', () => {
    expect(estaAtendiendo(utc('2026-08-11T12:00:00'), HORARIO)).toBe(true);  // 08:00 local
    expect(estaAtendiendo(utc('2026-08-11T11:59:00'), HORARIO)).toBe(false); // 07:59 local
    expect(estaAtendiendo(utc('2026-08-11T21:59:00'), HORARIO)).toBe(true);  // 17:59 local
    expect(estaAtendiendo(utc('2026-08-11T22:00:00'), HORARIO)).toBe(false); // 18:00 local
  });

  /**
   * La prueba que justifica toda la función: el VPS está en Estados Unidos. A
   * las 02:00 UTC del miércoles en Bolivia son las 22:00 del MARTES —fuera de
   * horario—, pero la hora local del servidor diría otra cosa. Si esto se
   * rompe, la clínica contesta "estamos cerrados" cuando está abierta.
   */
  it('usa la hora de la clínica, no la del servidor', () => {
    const madrugadaUtc = utc('2026-08-12T02:00:00'); // miércoles 02:00 UTC
    expect(estaAtendiendo(madrugadaUtc, HORARIO)).toBe(false); // martes 22:00 en Bolivia

    const nuevaYork = parsearHorario('L-V:08:00-18:00', 'America/New_York')!;
    expect(estaAtendiendo(madrugadaUtc, nuevaYork)).toBe(false); // martes 22:00 allí también

    const madrid = parsearHorario('L-V:08:00-18:00', 'Europe/Madrid')!;
    expect(estaAtendiendo(madrugadaUtc, madrid)).toBe(false); // miércoles 04:00, aún cerrado
  });

  it('una clínica abierta toda la semana no deja huecos', () => {
    const siempre = parsearHorario('L-D:00:00-23:59')!;
    expect(estaAtendiendo(utc('2026-08-09T03:00:00'), siempre)).toBe(true);
  });
});
