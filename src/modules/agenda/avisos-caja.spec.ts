import { CUERPO_PLANTILLA_AVISO_CAJA, estadoPlantillaCaja, parametroLimpio, parametrosAvisoCaja } from './avisos-caja';

const fila = { paciente: 'Ana  María\nPérez', ci: '7773356', medico: 'Juan Carlos Montalvo Doria Medina', fecha: '2026-11-02', hora: '15:00', precio: '400.00' };

describe('parametrosAvisoCaja', () => {
  it('arma las cinco variables en el orden del cuerpo, con la cita y el monto legibles', () => {
    expect(parametrosAvisoCaja(fila)).toEqual(['Ana María Pérez', '7773356', 'Juan Carlos Montalvo Doria Medina', 'lunes, 2 de noviembre, 15:00', 'Bs 400']);
    expect(CUERPO_PLANTILLA_AVISO_CAJA.match(/\{\{\d\}\}/g)).toEqual(['{{1}}', '{{2}}', '{{3}}', '{{4}}', '{{5}}']);
  });

  it('nunca manda un parámetro vacío: Meta rechazaría el mensaje entero', () => {
    const p = parametrosAvisoCaja({ ...fila, ci: null, precio: null, paciente: '   ' });
    expect(p[0]).toBe('—');
    expect(p[1]).toBe('—');
    expect(p[4]).toBe('—');
    expect(p.every(x => x.length > 0 && !/[\n\t]| {2,}/.test(x))).toBe(true);
  });

  it('corta lo demasiado largo', () => {
    expect(parametroLimpio('x'.repeat(500))).toHaveLength(120);
  });
});

describe('estadoPlantillaCaja', () => {
  const p = (status: string, name = 'montalvo_comprobante_caja', language = 'es') => ({ name, language, status });
  it('solo APPROVED en español es aprobada', () => {
    expect(estadoPlantillaCaja([p('APPROVED')])).toBe('APROBADA');
    expect(estadoPlantillaCaja([p('PENDING')])).toBe('EN_REVISION');
    expect(estadoPlantillaCaja([p('REJECTED')])).toBe('RECHAZADA');
    expect(estadoPlantillaCaja([p('PAUSED')])).toBe('RECHAZADA');
    expect(estadoPlantillaCaja([p('APPROVED', 'otra')])).toBe('NO_EXISTE');
    expect(estadoPlantillaCaja([p('APPROVED', undefined, 'en_US')])).toBe('NO_EXISTE');
    expect(estadoPlantillaCaja(null)).toBe('SIN_CONEXION');
  });
});
