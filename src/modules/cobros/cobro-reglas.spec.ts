import { bolivianos, estadoDelCobro, textoDelQr } from './cobro-reglas';

const HOY = new Date(Date.UTC(2026, 9, 6));

describe('cuándo se puede cobrar con el QR de una línea', () => {
  it.each([
    [{ activo: true, imagenId: 'q', venceEl: null }, 'LISTO'],
    [{ activo: false, imagenId: 'q', venceEl: null }, 'APAGADO'],
    [{ activo: true, imagenId: null, venceEl: null }, 'SIN_QR'],
    [{ activo: true, imagenId: 'q', venceEl: new Date(Date.UTC(2026, 9, 5)) }, 'VENCIDO'],
    /* Vence hoy: todavía sirve. */
    [{ activo: true, imagenId: 'q', venceEl: new Date(Date.UTC(2026, 9, 6)) }, 'LISTO'],
  ])('%j → %s', (cobro, estado) => expect(estadoDelCobro(cobro, HOY)).toBe(estado));
});

describe('el texto que acompaña al QR', () => {
  it('dice el monto, el banco, a nombre de quién y qué mandar después', () => {
    const texto = textoDelQr({ titulo: 'Control prenatal', monto: 1250.5, banco: 'BCP', titular: 'Clínica Montalvo SRL', instrucciones: 'Pon tu nombre en la glosa.' });
    expect(texto).toContain(`${bolivianos(1250.5)}`);
    expect(texto).toContain('BCP, a nombre de Clínica Montalvo SRL');
    expect(texto).toContain('comprobante');
    expect(texto).toContain('Pon tu nombre en la glosa.');
  });

  it('formatea Bs a la boliviana', () => {
    expect(bolivianos(280)).toBe('Bs 280');
    expect(bolivianos(1250.5)).toMatch(/^Bs 1\.?250,50$/);
  });
});
