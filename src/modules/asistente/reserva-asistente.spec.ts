import { datosNoDichos, reservasDelAsistenteEn, resumenDeReserva, textoHoraOcupada } from './reserva-asistente';

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
