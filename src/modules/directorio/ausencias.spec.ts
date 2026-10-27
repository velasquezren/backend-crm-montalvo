import { ausenciaDelDia, ausenciasEnRango, sumarDias } from './ausencias';

describe('ausencias de un médico', () => {
  const a = (desde: string, hasta: string, motivo: string | null = null) => ({ desde, hasta, motivo });

  it('los dos extremos son días de ausencia', () => {
    const lista = [a('2026-12-20', '2026-12-31')];
    expect(ausenciaDelDia(lista, '2026-12-19')).toBeNull();
    expect(ausenciaDelDia(lista, '2026-12-20')).toEqual(lista[0]);
    expect(ausenciaDelDia(lista, '2026-12-31')).toEqual(lista[0]);
    expect(ausenciaDelDia(lista, '2027-01-01')).toBeNull();
  });

  it('suma días de calendario, con cambio de mes y año', () => {
    expect(sumarDias('2026-12-31', 1)).toBe('2027-01-01');
    expect(sumarDias('2028-02-28', 1)).toBe('2028-02-29');
    expect(sumarDias('2026-10-27', 29)).toBe('2026-11-25');
  });

  it('«vuelve» salta ausencias pegadas: congreso y después vacaciones', () => {
    const lista = [a('2026-11-10', '2026-11-14', 'Vacaciones'), a('2026-11-05', '2026-11-09', 'Congreso')];
    expect(ausenciasEnRango(lista, '2026-11-01', '2026-11-30')).toEqual([
      { desde: '2026-11-05', hasta: '2026-11-09', motivo: 'Congreso', vuelve: '2026-11-15' },
      { desde: '2026-11-10', hasta: '2026-11-14', motivo: 'Vacaciones', vuelve: '2026-11-15' },
    ]);
  });

  it('solo las que tocan el rango', () => {
    const lista = [a('2026-11-01', '2026-11-03'), a('2026-12-20', '2026-12-31')];
    expect(ausenciasEnRango(lista, '2026-11-03', '2026-11-30').map(x => x.desde)).toEqual(['2026-11-01']);
  });
});
