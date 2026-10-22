import type { DatosComprobante } from '../asistente/modelo.port';
import { decidirComprobanteDeReserva, detalleDeLectura, evaluarComprobanteDeReserva, lecturaGuardada, textoRevisionParaPaciente } from './comprobante-reserva';

const pedidoEn = new Date('2026-10-22T19:00:00Z'); // 15:00 en La Paz
const ahora = new Date('2026-10-22T19:20:00Z');
const esperado = { monto: 400, pedidoEn, ahora, referenciaRepetida: false };
const datos = (c: Partial<DatosComprobante> = {}): DatosComprobante => ({
  esComprobante: true, monto: 400, moneda: 'Bs', fechaHora: '2026-10-22T15:12', referencia: '123456789',
  banco: 'BISA', destinatario: 'Juan Carlos Montalvo', ordenante: 'Ana Pérez', ...c,
});

describe('evaluarComprobanteDeReserva', () => {
  it('coincide sin comparar el destinatario: el QR de la agenda no dice a nombre de quién está', () => {
    const r = evaluarComprobanteDeReserva(datos({ destinatario: 'Otra persona' }), esperado);
    expect(r.resultado).toBe('COINCIDE');
    expect(r.verificaciones.map(v => v.campo)).toEqual(['MONTO', 'FECHA', 'REFERENCIA']);
  });

  it('un monto menor, una fecha anterior al QR o una operación repetida piden revisión', () => {
    expect(evaluarComprobanteDeReserva(datos({ monto: 250 }), esperado).resultado).toBe('REVISAR');
    expect(evaluarComprobanteDeReserva(datos({ fechaHora: '2026-10-21T10:00' }), esperado).resultado).toBe('REVISAR');
    expect(evaluarComprobanteDeReserva(datos(), { ...esperado, referenciaRepetida: true }).resultado).toBe('REVISAR');
  });

  it('sin fecha ni operación legibles tampoco pasa solo', () => {
    expect(evaluarComprobanteDeReserva(datos({ fechaHora: null }), esperado).resultado).toBe('REVISAR');
    expect(evaluarComprobanteDeReserva(datos({ referencia: null }), esperado).resultado).toBe('REVISAR');
  });

  it('lo que no es un comprobante lo dice así', () => {
    expect(evaluarComprobanteDeReserva(datos({ esComprobante: false }), esperado).resultado).toBe('NO_ES_COMPROBANTE');
  });
});

describe('decidirComprobanteDeReserva', () => {
  it('solo lo que coincide se registra; lo que no es comprobante se pide una vez', () => {
    expect(decidirComprobanteDeReserva({ resultado: 'COINCIDE' }, null)).toBe('REGISTRAR');
    expect(decidirComprobanteDeReserva({ resultado: 'REVISAR' }, null)).toBe('REVISAR');
    expect(decidirComprobanteDeReserva({ resultado: 'NO_ES_COMPROBANTE' }, null)).toBe('PEDIR_OTRO');
    expect(decidirComprobanteDeReserva({ resultado: 'NO_ES_COMPROBANTE' }, { resultado: 'NO_ES_COMPROBANTE', mensajeId: 'a' })).toBe('REVISAR');
  });
});

describe('detalleDeLectura', () => {
  it('pone primero lo grave y cabe en la columna', () => {
    const r = evaluarComprobanteDeReserva(datos({ monto: 250, referencia: null }), esperado);
    const detalle = detalleDeLectura(r);
    expect(detalle.indexOf('se esperaba')).toBeLessThan(detalle.indexOf('número de operación'));
    expect(detalle.length).toBeLessThanOrEqual(300);
  });
});

describe('textoRevisionParaPaciente', () => {
  it('le dice el monto si es lo que no cuadra, y nunca la acusa de nada', () => {
    expect(textoRevisionParaPaciente(evaluarComprobanteDeReserva(datos({ monto: 250 }), esperado), 40000)).toContain('(Bs 400)');
    const repetida = textoRevisionParaPaciente(evaluarComprobanteDeReserva(datos(), { ...esperado, referenciaRepetida: true }), 40000);
    expect(repetida).toContain('no pudimos validarlo automáticamente');
    expect(repetida).not.toMatch(/reutiliz|repetid|fraude/i);
    expect(textoRevisionParaPaciente(null, 40000)).toContain('Una persona del equipo');
    expect(textoRevisionParaPaciente({ resultado: 'NO_ES_COMPROBANTE', verificaciones: [] }, 40000)).toContain('tampoco parece');
  });
});

describe('lecturaGuardada', () => {
  it('descarta lo que no tiene la forma de una lectura', () => {
    expect(lecturaGuardada(null)).toBeNull();
    expect(lecturaGuardada({ version: 2, mensajeId: 'x', verificaciones: [], resultado: 'COINCIDE' })).toBeNull();
    expect(lecturaGuardada({ version: 1, mensajeId: 'x', verificaciones: [], resultado: 'COINCIDE' })).not.toBeNull();
  });
});
