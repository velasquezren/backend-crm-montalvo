import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bloquesDeCasillas, CasillaActiva, DIAS_AGENDA, horarioHtml, horasDeLaGrilla } from './horario-html';

/** `horario_html` de un médico real (sin su nombre), copiado de la agenda el 7/10/2026: Lun–Vie 9:30 a 11:00. */
const PRODUCCION = readFileSync(join(__dirname, '../../../test/agenda/horario-html-produccion.html'), 'utf8');

const casillas = (dias: readonly string[], horas: string[]) =>
  dias.flatMap(dia => horas.map(hora => ({ dia, hora }) as CasillaActiva));

describe('horarioHtml', () => {
  it('reproduce byte a byte el recuadro que escribió ScriptCase', () => {
    const lunesAViernes = DIAS_AGENDA.filter(d => d !== 'Sabado');
    expect(horarioHtml(casillas(lunesAViernes, ['09:30', '10:00', '10:30', '11:00']))).toBe(PRODUCCION);
  });

  it('separa mañana y tarde a las 13:00 y escribe la hora sin cero inicial', () => {
    const html = horarioHtml([
      { dia: 'Sabado', hora: '08:00' }, { dia: 'Sabado', hora: '12:30' },
      { dia: 'Sabado', hora: '13:00' }, { dia: 'Sabado', hora: '18:30' },
      { dia: 'Miercoles', hora: '15:00' },
    ]);
    expect(html).toContain('>8:00-12:30</td>');
    expect(html).toContain('>13:00-18:30</td>');
    // Una sola casilla es una sola hora, no «15:00-15:00».
    expect(html).toContain('>15:00</td>');
    expect(html).not.toContain('15:00-15:00');
  });

  it('sin casillas encendidas el HTML queda vacío (la web lo ofrece «a solicitud»)', () => {
    expect(horarioHtml([])).toBe('');
  });
});

describe('horasDeLaGrilla', () => {
  it('de 07:00 a 20:30 cada media hora, más las horas que el médico ya tenga fuera de ese rango', () => {
    const base = horasDeLaGrilla([]);
    expect(base[0]).toBe('07:00');
    expect(base[base.length - 1]).toBe('20:30');
    expect(base).toHaveLength(28);
    expect(horasDeLaGrilla(['06:30', '09:00'])).toEqual(['06:30', ...base]);
  });
});

describe('bloquesDeCasillas', () => {
  it('un bloque de mañana y uno de tarde por día, hasta el FINAL de la última casilla', () => {
    expect(bloquesDeCasillas([
      { dia: 'Martes', hora: '15:00' }, { dia: 'Lunes', hora: '09:30' }, { dia: 'Lunes', hora: '09:00' },
      { dia: 'Lunes', hora: '11:00' }, { dia: 'Martes', hora: '18:30' }, { dia: 'Sabado', hora: '12:30' },
    ])).toEqual([
      { diaSemana: 1, inicioMinuto: 540, finMinuto: 690 },
      { diaSemana: 2, inicioMinuto: 900, finMinuto: 1140 },
      { diaSemana: 6, inicioMinuto: 750, finMinuto: 780 },
    ]);
    expect(bloquesDeCasillas([])).toEqual([]);
  });
});
