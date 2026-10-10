import { datosComprobanteDe, evaluarComprobante, instanteDeLaPaz, referenciaComparable } from './comprobante';
import type { DatosComprobante } from './modelo.port';

const BIEN: DatosComprobante = {
  esComprobante: true, monto: 280, moneda: 'Bs', fechaHora: '2026-10-10T14:32', referencia: '0012-3456',
  banco: 'BNB', destinatario: 'CLINICA MONTALVO SRL', ordenante: 'Ana Pérez',
};
const ESPERADO = {
  monto: 280, titular: 'Clínica Montalvo S.R.L.', pedidoEn: new Date('2026-10-10T18:00:00Z'), ahora: new Date('2026-10-10T19:00:00Z'), referenciaRepetida: false,
};
const estado = (d: DatosComprobante, e = ESPERADO) => Object.fromEntries(evaluarComprobante(d, e).verificaciones.map(v => [v.campo, v.estado]));

describe('evaluarComprobante', () => {
  it('un comprobante que cuadra en todo COINCIDE', () => {
    const r = evaluarComprobante(BIEN, ESPERADO);
    expect(r.resultado).toBe('COINCIDE');
    expect(r.verificaciones.every(v => v.estado === 'OK')).toBe(true);
  });

  it('un monto distinto es ALERTA y lo dice con los dos montos', () => {
    const r = evaluarComprobante({ ...BIEN, monto: 250 }, ESPERADO);
    expect(r.resultado).toBe('REVISAR');
    expect(r.verificaciones.find(v => v.campo === 'MONTO')).toMatchObject({ estado: 'ALERTA', texto: expect.stringContaining('250') });
  });

  it('un pago en dólares es ALERTA aunque el número coincida', () => {
    expect(estado({ ...BIEN, moneda: 'USD' }).MONTO).toBe('ALERTA');
  });

  it('a nombre de otra persona es ALERTA; enmascarado o parcial es ADVERTENCIA', () => {
    expect(estado({ ...BIEN, destinatario: 'Juan Quispe' }).DESTINATARIO).toBe('ALERTA');
    expect(estado({ ...BIEN, destinatario: 'CLINICA M***' }).DESTINATARIO).toBe('ADVERTENCIA');
  });

  it('una fecha anterior al QR es ALERTA (un comprobante viejo reciclado)', () => {
    expect(estado({ ...BIEN, fechaHora: '2026-10-01T10:00' }).FECHA).toBe('ALERTA');
  });

  it('una fecha futura es ALERTA; con solo el día, el mismo día del QR vale', () => {
    expect(estado({ ...BIEN, fechaHora: '2026-10-12T10:00' }).FECHA).toBe('ALERTA');
    expect(estado({ ...BIEN, fechaHora: '2026-10-10' }).FECHA).toBe('OK');
  });

  it('una referencia que ya llegó en otro pago es ALERTA: puede ser un comprobante reutilizado', () => {
    expect(estado(BIEN, { ...ESPERADO, referenciaRepetida: true }).REFERENCIA).toBe('ALERTA');
  });

  it('lo que no se leyó no se da por bueno', () => {
    const r = evaluarComprobante({ ...BIEN, monto: null, referencia: null, fechaHora: null, destinatario: null }, ESPERADO);
    expect(r.resultado).toBe('REVISAR');
    expect(r.verificaciones.some(v => v.estado === 'OK')).toBe(false);
  });

  it('algo que no es un comprobante se dice así, sin más verificaciones', () => {
    const r = evaluarComprobante({ ...BIEN, esComprobante: false }, ESPERADO);
    expect(r).toEqual({ resultado: 'NO_ES_COMPROBANTE', verificaciones: [expect.objectContaining({ campo: 'COMPROBANTE', estado: 'ALERTA' })] });
  });
});

describe('piezas de la lectura', () => {
  it('la fecha leída se interpreta en hora de Bolivia (−04:00)', () => {
    expect(instanteDeLaPaz('2026-10-10T14:32')?.instante.toISOString()).toBe('2026-10-10T18:32:00.000Z');
    expect(instanteDeLaPaz('10/10/2026')).toBeNull();
  });

  it('la referencia se compara sin espacios ni guiones, y una de 3 caracteres no cuenta', () => {
    expect(referenciaComparable(' 0012-3456 ')).toBe('00123456');
    expect(referenciaComparable('12')).toBeNull();
  });

  it('lo que devuelve el modelo se valida: un monto en texto no pasa', () => {
    expect(() => datosComprobanteDe({ ...BIEN, monto: '280' })).toThrow();
    expect(() => datosComprobanteDe({ monto: 1 })).toThrow();
    expect(datosComprobanteDe({ ...BIEN, banco: '  ' }).banco).toBeNull();
  });
});
