import { erroresDelHorario, horaDeMinutos, minutosDeHora, resumenDelHorario } from './horario';

const b = (diaSemana: number, desde: string, hasta: string) => ({ diaSemana, inicioMinuto: minutosDeHora(desde)!, finMinuto: minutosDeHora(hasta)! });

describe('horario semanal', () => {
  it('convierte horas y minutos', () => {
    expect(minutosDeHora('08:30')).toBe(510);
    expect(minutosDeHora('24:00')).toBe(1440);
    expect(minutosDeHora('24:30')).toBeNull();
    expect(minutosDeHora('8:30')).toBeNull();
    expect(horaDeMinutos(510)).toBe('08:30');
  });

  it('un horario vacío es válido: atiende a solicitud', () => {
    expect(erroresDelHorario([])).toEqual([]);
    expect(resumenDelHorario([])).toBe('Con cita a solicitud');
  });

  it('rechaza bloques al revés, solapados, días inexistentes y demasiados por día', () => {
    expect(erroresDelHorario([b(1, '12:00', '08:00')])).toHaveLength(1);
    expect(erroresDelHorario([b(1, '08:00', '12:00'), b(1, '11:00', '13:00')])[0]).toMatch(/superponen/);
    expect(erroresDelHorario([{ diaSemana: 8, inicioMinuto: 0, finMinuto: 60 }])[0]).toMatch(/Día inválido/);
    const cinco = ['07:00', '09:00', '11:00', '13:00', '15:00'].map(h => b(2, h, horaDeMinutos(minutosDeHora(h)! + 60)));
    expect(erroresDelHorario(cinco)[0]).toMatch(/más de 4 bloques/);
  });

  it('bloques que se tocan no se solapan', () => {
    expect(erroresDelHorario([b(1, '08:00', '12:00'), b(1, '12:00', '14:00')])).toEqual([]);
  });

  it('agrupa días iguales y dice rangos seguidos', () => {
    const semana = [1, 2, 3, 4, 5].map(d => b(d, '08:00', '12:00'));
    expect(resumenDelHorario([...semana, b(6, '09:00', '12:00')])).toBe('Lunes a viernes, 08:00–12:00 · sábado, 09:00–12:00');
    expect(resumenDelHorario([b(1, '08:00', '12:00'), b(3, '08:00', '12:00'), b(5, '08:00', '12:00')])).toBe('Lunes, miércoles y viernes, 08:00–12:00');
    expect(resumenDelHorario([b(2, '15:00', '19:00'), b(2, '08:00', '12:00')])).toBe('Martes, 08:00–12:00 y 15:00–19:00');
  });
});
