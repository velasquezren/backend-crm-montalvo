import {
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
