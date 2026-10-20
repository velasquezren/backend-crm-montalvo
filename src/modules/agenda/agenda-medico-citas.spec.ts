import { armarAgendaDelDia, nombreComparable } from './agenda-medico-citas';

/*
 * La regla de qué cuenta como una cita del médico, sin base. La consulta SQL
 * que trae las filas se prueba contra MySQL real en `agenda.mysql.integracion.spec.ts`.
 */
const DIA = '2026-10-12';

describe('la agenda de un médico: qué cuenta y cómo se junta', () => {
  it('las citas de agenda_med son «Confirmada» y las reservas sin cargar, pendientes de dos clases', () => {
    const a = armarAgendaDelDia(DIA,
      [{ hora: '09:00', paciente: 'Ana Pérez' }],
      [{ hora: '10:00', paciente: 'Carla Soto', estado: 'PAGADO' }, { hora: '11:00', paciente: 'Dina Rojas', estado: 'PENDIENTE' }]);
    expect(a.citas).toEqual([
      { hora: '09:00', paciente: 'Ana Pérez', estado: 'CONFIRMADA' },
      { hora: '10:00', paciente: 'Carla Soto', estado: 'PAGO_POR_VERIFICAR' },
      { hora: '11:00', paciente: 'Dina Rojas', estado: 'POR_CONFIRMAR' },
    ]);
    expect(a).toMatchObject({ fecha: DIA, confirmadas: 1, pendientes: 2, porConfirmar: 1, pagoPorVerificar: 1, total: 3 });
  });

  it('una reserva ATENDIDO ya está en agenda_med y un estado desconocido no se adivina: ninguna cuenta', () => {
    const a = armarAgendaDelDia(DIA, [], [
      { hora: '09:00', paciente: 'Ya Cargada', estado: 'ATENDIDO' },
      { hora: '09:30', paciente: 'Estado Nuevo', estado: 'ANULADA' },
      { hora: '10:00', paciente: 'Sin Estado', estado: '' },
    ]);
    expect(a.total).toBe(0);
  });

  it('la reserva que recepción ya cargó en FileMaker (misma paciente, misma casilla) no se cuenta dos veces', () => {
    const a = armarAgendaDelDia(DIA,
      [{ hora: '09:45', paciente: 'María  Pérez' }],
      /* FileMaker agenda a :15 y :45; la web a la hora en punto. Mismo nombre salvo tildes, mayúsculas y espacios. */
      [{ hora: '09:30', paciente: 'maria perez', estado: 'PENDIENTE' }]);
    expect(a.citas).toEqual([{ hora: '09:45', paciente: 'María Pérez', estado: 'CONFIRMADA' }]);
    expect(a).toMatchObject({ confirmadas: 1, pendientes: 0, total: 1 });
  });

  it('dos personas distintas a la misma hora son dos citas; la misma persona a otra hora, también', () => {
    const mismaHora = armarAgendaDelDia(DIA, [{ hora: '09:00', paciente: 'Ana Pérez' }], [{ hora: '09:00', paciente: 'Ana Pereira', estado: 'PENDIENTE' }]);
    expect(mismaHora.total).toBe(2);
    const otraHora = armarAgendaDelDia(DIA, [{ hora: '09:00', paciente: 'Ana Pérez' }], [{ hora: '15:00', paciente: 'Ana Pérez', estado: 'PENDIENTE' }]);
    expect(otraHora.total).toBe(2);
  });

  it('sin nombre no se junta nada (no se sabe si es la misma) y se dice que falta, sin inventar uno', () => {
    const a = armarAgendaDelDia(DIA, [{ hora: '09:00', paciente: null }], [{ hora: '09:00', paciente: '  ', estado: 'PENDIENTE' }]);
    expect(a.total).toBe(2);
    expect(a.citas.map(c => c.paciente)).toEqual(['Sin nombre registrado', 'Sin nombre registrado']);
  });

  it('sale ordenada por hora aunque lleguen mezcladas, y los segundos de la hora no estorban', () => {
    const a = armarAgendaDelDia(DIA, [{ hora: '15:00:00', paciente: 'B' }, { hora: '08:30', paciente: 'A' }], [{ hora: '12:00', paciente: 'C', estado: 'PENDIENTE' }]);
    expect(a.citas.map(c => c.hora)).toEqual(['08:30', '12:00', '15:00']);
  });

  it('la cita de FileMaker lleva su actividad y su seguro; lo vacío no deja claves, y la reserva juntada toma los de la cita', () => {
    const a = armarAgendaDelDia(DIA,
      [
        { hora: '09:00', paciente: 'Ana Pérez', actividad: ' Ecografía   FIV ', seguro: 'Particular' },
        { hora: '10:00', paciente: 'Luis Gómez', actividad: '', seguro: null },
      ],
      [{ hora: '09:00', paciente: 'ana perez', estado: 'PENDIENTE' }, { hora: '11:00', paciente: 'Dina Rojas', estado: 'PENDIENTE' }]);
    expect(a.citas).toEqual([
      { hora: '09:00', paciente: 'Ana Pérez', estado: 'CONFIRMADA', actividad: 'Ecografía FIV', seguro: 'Particular' },
      { hora: '10:00', paciente: 'Luis Gómez', estado: 'CONFIRMADA' },
      { hora: '11:00', paciente: 'Dina Rojas', estado: 'POR_CONFIRMAR' },
    ]);
    expect(Object.keys(a.citas[1])).toEqual(['hora', 'paciente', 'estado']);
  });

  it('un día vacío da ceros, no un error', () => {
    expect(armarAgendaDelDia(DIA, [], [])).toEqual({ fecha: DIA, citas: [], confirmadas: 0, pendientes: 0, porConfirmar: 0, pagoPorVerificar: 0, total: 0 });
  });

  it('nombreComparable ignora tildes, mayúsculas y espacios', () => {
    expect(nombreComparable('  JOSÉ   Peña ')).toBe('jose pena');
    expect(nombreComparable(null)).toBe('');
  });
});
