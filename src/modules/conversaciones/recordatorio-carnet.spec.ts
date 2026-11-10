import { FilaReservaAgenda } from '../agenda/agenda-consulta.sql';
import { Prisma } from '../../prisma/prisma-client';
import { textoConstancia } from './constancia-reserva';
import { datosDeConstancia } from './constancia-reserva.service';
import { pideCarnet, RECORDATORIO_CARNET } from './recordatorio-carnet';
import { textoPagoDeReserva, textoReservaSinPago } from './reservas-chat';

const fila = (medicoId: number | null): FilaReservaAgenda => ({
  id: 82, fecha: '2026-11-10', hora: '17:00:00', medicoId, medico: 'Juan Carlos Montalvo Doria Medina', especialidad: 'Ginecologia',
  paciente: 'Paciente sintética', telefono: '70012345', ci: '1234567', observaciones: null, estado: 'PAGADO', precio: '400.00',
  nit: null, razonSocial: null, tieneComprobante: true, registradaEl: null, registradaA: null,
});

describe('el recordatorio del carnet', () => {
  it('es solo del Dr. Montalvo (medico_pk 1), no de los otros «Montalvo» ni de un cierre sin médico', () => {
    expect(pideCarnet(1)).toBe(true);
    for (const otro of [6, 7, 15, 47, null, undefined]) expect(pideCarnet(otro)).toBe(false);
  });

  it('al reservar va al final del texto del QR, en su propio párrafo', () => {
    const texto = textoPagoDeReserva(40000, undefined, 1);
    expect(texto.endsWith(`\n\n${RECORDATORIO_CARNET}`)).toBe(true);
    expect(texto).toContain('pague Bs 400 con este QR');
    expect(textoPagoDeReserva(25000, undefined, 47)).not.toContain('carnet');
    expect(textoPagoDeReserva(25000)).not.toContain('carnet');
  });

  it('la reserva del asistente sin cobro por el chat también lo lleva', () => {
    expect(textoReservaSinPago('con el Dr. Montalvo, martes 10 de noviembre a las 17:00', 1)).toContain(RECORDATORIO_CARNET);
    expect(textoReservaSinPago('con la Dra. Vallejos, martes 10 de noviembre a las 17:00', 47)).not.toContain('carnet');
  });

  it('al pagar, la constancia lo dice después del estado del pago', () => {
    const conMontalvo = textoConstancia(datosDeConstancia(fila(1), new Prisma.Decimal('400.00')));
    expect(conMontalvo.endsWith(`\n\n${RECORDATORIO_CARNET}`)).toBe(true);
    expect(conMontalvo.length).toBeLessThan(1024);
    expect(textoConstancia(datosDeConstancia(fila(47), new Prisma.Decimal('250.00')))).not.toContain('carnet');
    expect(textoConstancia(datosDeConstancia(fila(null), null))).not.toContain('carnet');
  });
});
