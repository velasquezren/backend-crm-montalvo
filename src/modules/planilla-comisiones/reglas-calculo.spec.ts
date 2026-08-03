import {
  cierraTrimestre,
  PlanCandidato,
  seleccionarPlanesComisionables,
  elegirTarifaRA,
  fraccionComisionable,
  mesesAnteriores,
  planesComisionables,
  resolverNivelCirugia,
} from './reglas-calculo';
import { NIVELES_CIRUGIA_POR_DEFECTO, TARIFAS_RA_POR_DEFECTO } from './configuracion-por-defecto';

describe('escala de cirugías (Tipo B)', () => {
  const tramos = NIVELES_CIRUGIA_POR_DEFECTO;

  it('sin llegar al primer tramo no hay comisión', () => {
    expect(resolverNivelCirugia(0, tramos)).toBeNull();
    expect(resolverNivelCirugia(999.99, tramos)).toBeNull();
  });

  it('ubica el acumulado dentro de su tramo', () => {
    expect(resolverNivelCirugia(1000, tramos)).toBe(1);
    expect(resolverNivelCirugia(3000, tramos)).toBe(1);
    expect(resolverNivelCirugia(25762.84, tramos)).toBe(5); // caso real de diciembre 2024
  });

  // Los tramos se tocan (…–5.000 y 5.000–…). Antes la frontera casaba con los
  // dos y ganaba el de abajo, o sea el que paga menos.
  it('en la frontera exacta manda el tramo de arriba', () => {
    expect(resolverNivelCirugia(5000, tramos)).toBe(2);
    expect(resolverNivelCirugia(10000, tramos)).toBe(3);
    expect(resolverNivelCirugia(30000, tramos)).toBe(6);
  });

  it('por encima del último tramo aplica ese último, sin inventar niveles', () => {
    expect(resolverNivelCirugia(40000, tramos)).toBe(6);
    expect(resolverNivelCirugia(500000, tramos)).toBe(6);
  });

  it('la escala llega hasta el nivel 6, como la planilla', () => {
    expect(Math.max(...tramos.map(t => t.nivel))).toBe(6);
  });
});

describe('objetivo de planes como franquicia (Tipo A)', () => {
  it('solo comisiona lo que SUPERA el objetivo', () => {
    expect(planesComisionables(5, 4)).toBe(1);
    expect(planesComisionables(7, 4)).toBe(3);
  });

  // Caso real: una vendedora hizo 4 paquetes con objetivo 4 y cobró cero.
  it('igualar el objetivo no comisiona', () => {
    expect(planesComisionables(4, 4)).toBe(0);
  });

  it('quedarse corto tampoco genera saldo negativo', () => {
    expect(planesComisionables(2, 4)).toBe(0);
  });

  it('sin objetivo comisionan todos', () => {
    expect(planesComisionables(3, 0)).toBe(3);
  });

  // Diciembre 2024, PLANNIN de Viviana: 2 vendidos, objetivo 1, base 1747,48.
  // La planilla pagó 26,21 = (1747,48 / 2) × 1 × 3%.
  it('prorratea la base según la proporción que comisiona', () => {
    const fraccion = fraccionComisionable(2, 1);
    expect(fraccion).toBe(0.5);
    expect(Math.round(1747.48 * fraccion * 0.03 * 100) / 100).toBe(26.21);
  });

  it('sin ventas no divide por cero', () => {
    expect(fraccionComisionable(0, 4)).toBe(0);
  });
});

describe('ventana del bono trimestral', () => {
  it('devuelve los meses anteriores al que se liquida', () => {
    expect(mesesAnteriores(2024, 12, 3)).toEqual([
      { anio: 2024, mes: 11 },
      { anio: 2024, mes: 10 },
    ]);
  });

  // El mes en curso no va en la lista: sus cifras se toman de memoria, porque
  // todavía no están guardadas cuando se calculan los bonos.
  it('no incluye el mes en curso', () => {
    expect(mesesAnteriores(2024, 12, 3)).not.toContainEqual({ anio: 2024, mes: 12 });
  });

  it('cruza el cambio de año', () => {
    expect(mesesAnteriores(2026, 1, 3)).toEqual([
      { anio: 2025, mes: 12 },
      { anio: 2025, mes: 11 },
    ]);
  });

  it('con ventana de un mes no mira hacia atrás', () => {
    expect(mesesAnteriores(2026, 5, 1)).toEqual([]);
  });
});

describe('tarifas de Reproducción Asistida', () => {
  const tarifas = TARIFAS_RA_POR_DEFECTO;

  it('reconoce el procedimiento por su nombre', () => {
    expect(elegirTarifaRA('Biopsia Embrionaria', tarifas)?.montoEmpresa).toBe(10);
    expect(elegirTarifaRA('Inseminación artificial', tarifas)?.montoEmpresa).toBe(5);
  });

  // "Histeroscopia" está contenido en "Laparoscopia + Histeroscopia": antes
  // ganaba el primero que devolviera la base, así que la misma venta podía
  // pagar 5 o 10 según el orden de las filas.
  it('gana la coincidencia más específica, no la primera', () => {
    const elegida = elegirTarifaRA('laparoscopia+ Histeroscopia', tarifas);
    expect(elegida?.procedimiento).toBe('Laparoscopia + Histeroscopia');
    expect(elegida?.montoEmpresa).toBe(10);
  });

  it('es estable aunque cambie el orden de las tarifas', () => {
    const alReves = [...tarifas].reverse();
    expect(elegirTarifaRA('laparoscopia+ Histeroscopia', alReves)?.procedimiento).toBe(
      'Laparoscopia + Histeroscopia',
    );
  });

  it('ignora acentos y mayúsculas', () => {
    expect(elegirTarifaRA('ASPIRACION DE OVULOS', tarifas)?.montoEmpresa).toBe(20);
  });

  it('un procedimiento desconocido no cruza con nada', () => {
    expect(elegirTarifaRA('Consulta de control', tarifas)).toBeUndefined();
  });
});

describe('cierre de trimestre', () => {
  it.each([3, 6, 9, 12])('el mes %i cierra trimestre', mes => {
    expect(cierraTrimestre(mes)).toBe(true);
  });

  it.each([1, 2, 4, 5, 7, 8, 10, 11])('el mes %i no lo cierra', mes => {
    expect(cierraTrimestre(mes)).toBe(false);
  });

  it('la ventana de un mes de cierre es el trimestre calendario', () => {
    expect(mesesAnteriores(2026, 3, 3)).toEqual([
      { anio: 2026, mes: 2 },
      { anio: 2026, mes: 1 },
    ]);
  });
});

describe('selección de planes comisionables', () => {
  /** Los 5 paquetes de Zuany en diciembre, con sus bases reales. */
  const zuany: PlanCandidato[] = [
    { id: 'bronce-1800', base: 1800.9, comisionaPlan: null },
    { id: 'bronce-2102', base: 2102.79, comisionaPlan: null },
    { id: 'gold-2579', base: 2579.34, comisionaPlan: null },
    { id: 'gold-3001-a', base: 3001.5, comisionaPlan: null },
    { id: 'gold-3001-b', base: 3001.5, comisionaPlan: null },
  ];

  it('sin decisión manual elige los de base más baja, como hizo la planilla', () => {
    const { elegidos, cupo } = seleccionarPlanesComisionables(zuany, 4);
    expect(cupo).toBe(1);
    expect([...elegidos]).toEqual(['bronce-1800']);
  });

  it('respeta lo que administración marcó, aunque no sea el más barato', () => {
    const conMarca = zuany.map(p =>
      p.id === 'gold-3001-a' ? { ...p, comisionaPlan: true } : p,
    );
    const { elegidos } = seleccionarPlanesComisionables(conMarca, 4);
    expect([...elegidos]).toEqual(['gold-3001-a']);
  });

  it('nunca elige uno descartado a mano', () => {
    const conDescarte = zuany.map(p =>
      p.id === 'bronce-1800' ? { ...p, comisionaPlan: false } : p,
    );
    const { elegidos } = seleccionarPlanesComisionables(conDescarte, 4);
    expect([...elegidos]).toEqual(['bronce-2102']);
  });

  it('completa el cupo con automáticos cuando la marca manual no alcanza', () => {
    const conMarca = zuany.map(p =>
      p.id === 'gold-3001-b' ? { ...p, comisionaPlan: true } : p,
    );
    const { elegidos, cupo } = seleccionarPlanesComisionables(conMarca, 2);
    expect(cupo).toBe(3);
    expect(elegidos.size).toBe(3);
    expect(elegidos.has('gold-3001-b')).toBe(true);
    expect(elegidos.has('bronce-1800')).toBe(true);
    expect(elegidos.has('bronce-2102')).toBe(true);
  });

  it('no paga de más si marcaron más de los que el objetivo permite', () => {
    const exceso = zuany.map(p => ({ ...p, comisionaPlan: true }));
    const { elegidos, cupo, descartadosPorCupo } = seleccionarPlanesComisionables(exceso, 4);
    expect(cupo).toBe(1);
    expect(elegidos.size).toBe(1);
    expect(descartadosPorCupo).toHaveLength(4);
  });

  it('igualar el objetivo no comisiona ninguno', () => {
    expect(seleccionarPlanesComisionables(zuany, 5).elegidos.size).toBe(0);
    expect(seleccionarPlanesComisionables(zuany, 9).cupo).toBe(0);
  });

  it('es determinista: dos corridas eligen lo mismo con bases empatadas', () => {
    const empate: PlanCandidato[] = [
      { id: 'b', base: 1000, comisionaPlan: null },
      { id: 'a', base: 1000, comisionaPlan: null },
      { id: 'c', base: 1000, comisionaPlan: null },
    ];
    const uno = [...seleccionarPlanesComisionables(empate, 2).elegidos];
    const dos = [...seleccionarPlanesComisionables([...empate].reverse(), 2).elegidos];
    expect(uno).toEqual(dos);
  });
});
