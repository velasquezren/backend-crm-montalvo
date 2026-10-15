import { datosNoDichos, reservaEnCurso, reservasDelAsistenteEn, resumenDeReserva, textoHoraOcupada } from './reserva-asistente';

/* El chat real del 15/10 que terminó derivado sin QR: los datos llegaron en tres líneas. */
const CHAT = '[Nota de voz, transcrita] Quiero agendar\nLunes 19\nreservar a mas 12\nrene velasquez\n11340617\n73605150';

describe('qué línea reserva por el asistente', () => {
  it('falla cerrado: vacía o ausente, ninguna', () => {
    expect(reservasDelAsistenteEn(undefined, 'l1')).toBe(false);
    expect(reservasDelAsistenteEn('', 'l1')).toBe(false);
    expect(reservasDelAsistenteEn(' , ', 'l1')).toBe(false);
  });

  it('solo las de la lista, o todas si se escribe a propósito', () => {
    expect(reservasDelAsistenteEn('l1, l2', 'l2')).toBe(true);
    expect(reservasDelAsistenteEn('l1,l2', 'l3')).toBe(false);
    expect(reservasDelAsistenteEn('todas', 'l3')).toBe(true);
  });
});

describe('nombre y carnet: solo los que ella escribió', () => {
  it('acepta lo que escribió aunque el modelo le ponga tildes y mayúsculas', () => {
    expect(datosNoDichos('René Velásquez', '11340617', CHAT)).toBeNull();
    expect(datosNoDichos('rene velasquez', '11340617', CHAT)).toBeNull();
  });

  it('un carnet escrito con puntos o con la extensión vale', () => {
    expect(datosNoDichos('Ana Pérez', '4567890', 'Ana Pérez, CI 4.567.890')).toBeNull();
    expect(datosNoDichos('Ana Pérez', '4567890 LP', 'ana perez 4567890')).toBeNull();
  });

  it('un apellido que ella no escribió no pasa: el modelo no completa nombres', () => {
    expect(datosNoDichos('René Velásquez Rojas', '11340617', CHAT)).toContain('no es el que ella escribió');
  });

  it('un nombre solo, sin apellido, se le pide', () => {
    expect(datosNoDichos('René', '11340617', CHAT)).toContain('nombre completo');
  });

  it('el teléfono no es un carnet, ni un número que no escribió', () => {
    expect(datosNoDichos('René Velásquez', '1134061', CHAT)).toContain('carnet');
    expect(datosNoDichos('René Velásquez', '99999999', CHAT)).toContain('no es el que ella escribió');
    expect(datosNoDichos('René Velásquez', 'LP', CHAT)).toContain('Falta el número de carnet');
  });
});

describe('lo que se le escribe', () => {
  it('el resumen dice médico, día y hora', () => {
    expect(resumenDeReserva({ medico: 'Dr. Juan Carlos Montalvo', fecha: '2026-10-19', hora: '12:00' }))
      .toBe('con Dr. Juan Carlos Montalvo el lunes 19 de octubre a las 12:00');
  });

  it('hora ocupada: las que quedan, o que ese día ya no hay', () => {
    const r = { fecha: '2026-10-19', hora: '12:00' };
    expect(textoHoraOcupada(r, ['12:30', '16:00'])).toMatch(/^Las 12:00 del lunes 19 de octubre se acaban de ocupar.*• 12:30\n• 16:00/s);
    expect(textoHoraOcupada(r, [])).toContain('ya no quedan horas libres');
  });
});

describe('¿vienen agendando? (de las herramientas de los turnos anteriores)', () => {
  const turno = (resultado: string, ...herramientas: object[]) => ({ resultado, herramientas });

  it('el chat del 15/10: médico, día y hora consultados; la cita sigue en curso cuando llegan sus datos', () => {
    expect(reservaEnCurso([
      turno('RESPONDIO', { nombre: 'buscar_medico', ok: true, medicoId: '49' }, { nombre: 'dias_con_cupo', ok: true, medicoId: '49' }),
      turno('RESPONDIO', { nombre: 'horas_libres', ok: true, medicoId: '49', fecha: '2026-10-23' }),
      turno('RESPONDIO'),
    ])).toEqual({ medicoId: '49', fecha: '2026-10-23' });
  });

  it('nada consultado, o solo lo que falló: no hay cita en curso', () => {
    expect(reservaEnCurso([])).toBeNull();
    expect(reservaEnCurso([turno('RESPONDIO', { nombre: 'listar_promociones', ok: true }), turno('RESPONDIO', { nombre: 'horas_libres', ok: false, medicoId: '49' })])).toBeNull();
  });

  it('otro médico la cambia y olvida el día del anterior; otro día del mismo médico lo reemplaza', () => {
    const t1 = turno('RESPONDIO', { nombre: 'horas_libres', ok: true, medicoId: '49', fecha: '2026-10-23' });
    expect(reservaEnCurso([t1, turno('RESPONDIO', { nombre: 'dias_con_cupo', ok: true, medicoId: '49' })])).toEqual({ medicoId: '49', fecha: '2026-10-23' });
    expect(reservaEnCurso([t1, turno('RESPONDIO', { nombre: 'ver_medico', ok: true, medicoId: '7' })])).toEqual({ medicoId: '7', fecha: null });
    expect(reservaEnCurso([t1, turno('RESPONDIO', { nombre: 'horas_libres', ok: true, medicoId: '49', fecha: '2026-10-26' })])).toEqual({ medicoId: '49', fecha: '2026-10-26' });
  });

  it('una reserva hecha, una derivación o un fallo la cierran', () => {
    const t1 = turno('RESPONDIO', { nombre: 'horas_libres', ok: true, medicoId: '49', fecha: '2026-10-23' });
    expect(reservaEnCurso([t1, turno('RESPONDIO', { nombre: 'reservar', ok: true, medicoId: '49', fecha: '2026-10-23' })])).toBeNull();
    expect(reservaEnCurso([t1, turno('DERIVO')])).toBeNull();
    expect(reservaEnCurso([t1, turno('FALLO')])).toBeNull();
    /* Un reservar rechazado (faltaba el carnet) no la cierra: sigue la misma cita. */
    expect(reservaEnCurso([t1, turno('RESPONDIO', { nombre: 'reservar', ok: false })])).toEqual({ medicoId: '49', fecha: '2026-10-23' });
  });

  it('un registro viejo o raro (sin medicoId, otro formato) no se toma por una cita', () => {
    expect(reservaEnCurso([turno('RESPONDIO', { nombre: 'horas_libres', ok: true }), { resultado: 'RESPONDIO', herramientas: null }])).toBeNull();
    expect(reservaEnCurso([turno('RESPONDIO', { nombre: 'horas_libres', ok: true, medicoId: '49; drop', fecha: 'mañana' })])).toBeNull();
  });
});
