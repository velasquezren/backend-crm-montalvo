import { desplazarEnCalendarioClinica, inicioDelDiaClinica, inicioDelMesClinica, sumarDiasClinica, ZONA_CLINICA } from './zona-clinica';

/**
 * A1 · el día de calendario de la clínica.
 *
 * Todas las aserciones son instantes ISO exactos, así que **no dependen de la
 * zona de la máquina que corre las pruebas**: es justo la dependencia que el
 * código anterior tenía y que esto viene a quitar.
 *
 * Bolivia es UTC-4 todo el año, sin cambio de hora: la medianoche de La Paz es
 * siempre las 04:00 UTC del mismo día.
 */

/** 16/09/2026 21:30 en La Paz — que en UTC ya es el 17. La franja del fallo. */
const NOCHE_DEL_16 = new Date('2026-09-17T01:30:00.000Z');

describe('A1 · inicioDelDiaClinica', () => {
  it('la zona es explícita y es la de la clínica', () => {
    expect(ZONA_CLINICA).toBe('America/La_Paz');
  });

  it('1 · instante normal, mismo día en UTC y en Bolivia', () => {
    // 16/09 14:00 en La Paz = 18:00 UTC del 16. Los dos calendarios coinciden.
    const inicio = inicioDelDiaClinica(new Date('2026-09-16T18:00:00.000Z'));
    expect(inicio.toISOString()).toBe('2026-09-16T04:00:00.000Z');
  });

  it('2 · franja en la que UTC ya está en el día siguiente', () => {
    /* Aquí estaba el fallo: el proceso en UTC leía «17 de septiembre» y partía
       el día ahí, así que lo de esta tarde en la clínica caía como vencido. */
    expect(NOCHE_DEL_16.toISOString().slice(0, 10)).toBe('2026-09-17');
    expect(inicioDelDiaClinica(NOCHE_DEL_16).toISOString()).toBe('2026-09-16T04:00:00.000Z');
  });

  it('3 · la medianoche de Bolivia abre el día, no lo cierra', () => {
    const medianoche = new Date('2026-09-17T04:00:00.000Z'); // 17/09 00:00 en La Paz
    expect(inicioDelDiaClinica(medianoche).toISOString()).toBe('2026-09-17T04:00:00.000Z');

    // Un milisegundo antes todavía es el día anterior.
    const unMsAntes = new Date(medianoche.getTime() - 1);
    expect(inicioDelDiaClinica(unMsAntes).toISOString()).toBe('2026-09-16T04:00:00.000Z');
  });

  it('4 · fin de mes', () => {
    // 30/09 22:00 en La Paz = 01:00 UTC del 1 de octubre.
    const finDeSeptiembre = new Date('2026-10-01T02:00:00.000Z');
    expect(inicioDelDiaClinica(finDeSeptiembre).toISOString()).toBe('2026-09-30T04:00:00.000Z');
    expect(sumarDiasClinica(inicioDelDiaClinica(finDeSeptiembre), 1).toISOString())
      .toBe('2026-10-01T04:00:00.000Z');
  });

  it('5 · fin de año', () => {
    // 31/12/2026 21:00 en La Paz = 01:00 UTC del 1 de enero de 2027.
    const nocheVieja = new Date('2027-01-01T01:00:00.000Z');
    expect(inicioDelDiaClinica(nocheVieja).toISOString()).toBe('2026-12-31T04:00:00.000Z');
    expect(sumarDiasClinica(inicioDelDiaClinica(nocheVieja), 1).toISOString())
      .toBe('2027-01-01T04:00:00.000Z');
  });

  it('febrero bisiesto no pierde el día 29', () => {
    const inicio = inicioDelDiaClinica(new Date('2028-02-28T18:00:00.000Z'));
    expect(sumarDiasClinica(inicio, 1).toISOString()).toBe('2028-02-29T04:00:00.000Z');
    expect(sumarDiasClinica(inicio, 2).toISOString()).toBe('2028-03-01T04:00:00.000Z');
  });

  it('sumar siete días cruza el mes sin aritmética de 24 h a mano', () => {
    const inicio = inicioDelDiaClinica(NOCHE_DEL_16);
    expect(sumarDiasClinica(inicio, 7).toISOString()).toBe('2026-09-23T04:00:00.000Z');
  });
});

describe('inicioDelMesClinica', () => {
  /* 31 de agosto a las 22:00 en La Paz = 1 de septiembre 02:00 UTC. */
  const NOCHE_DEL_31 = new Date('2026-09-01T02:00:00.000Z');

  it('la última noche del mes sigue siendo ese mes en la clínica', () => {
    expect(inicioDelMesClinica(NOCHE_DEL_31).toISOString()).toBe('2026-08-01T04:00:00.000Z');
  });

  it('desplaza meses cruzando el año', () => {
    const enero = new Date('2026-01-15T15:00:00.000Z');
    expect(inicioDelMesClinica(enero, -1).toISOString()).toBe('2025-12-01T04:00:00.000Z');
    expect(inicioDelMesClinica(enero, 1).toISOString()).toBe('2026-02-01T04:00:00.000Z');
  });
});

describe('desplazarEnCalendarioClinica', () => {
  /* Martes 27 de octubre de 2026, 10:00 en La Paz (14:00 UTC). El 1 de
     noviembre Estados Unidos sale del horario de verano; Bolivia no cambia. */
  const MARTES_10 = new Date('2026-10-27T14:00:00.000Z');

  it('una semana después sigue siendo a las 10:00 en La Paz, aunque EE. UU. cambie de hora', () => {
    expect(desplazarEnCalendarioClinica(MARTES_10, { dias: 7 }).toISOString()).toBe('2026-11-03T14:00:00.000Z');
    expect(desplazarEnCalendarioClinica(MARTES_10, { dias: 14 }).toISOString()).toBe('2026-11-10T14:00:00.000Z');
  });

  it('un mes después, el mismo día y hora; y conserva segundos y milisegundos', () => {
    expect(desplazarEnCalendarioClinica(new Date('2026-10-27T14:00:05.250Z'), { meses: 1 }).toISOString()).toBe('2026-11-27T14:00:05.250Z');
  });

  it('cruza el año', () => {
    expect(desplazarEnCalendarioClinica(new Date('2026-12-15T14:00:00.000Z'), { meses: 1 }).toISOString()).toBe('2027-01-15T14:00:00.000Z');
  });

  it('las 22:00 de La Paz (ya el día siguiente en UTC) siguen siendo las 22:00', () => {
    expect(desplazarEnCalendarioClinica(new Date('2026-10-28T02:00:00.000Z'), { dias: 7 }).toISOString()).toBe('2026-11-04T02:00:00.000Z');
  });
});
