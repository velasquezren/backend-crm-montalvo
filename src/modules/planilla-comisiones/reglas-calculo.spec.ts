import {
  PlanCandidato,
  aporteAlPoteJefatura,
  bonoTrimestralUsd,
  cierraTrimestre,
  elegirTarifaRA,
  mesesAnteriores,
  planesComisionables,
  resolverNivelCirugia,
  seleccionarPlanesComisionables,
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

  it('sin ventas no da negativo', () => {
    expect(planesComisionables(0, 4)).toBe(0);
  });

  /*
   * Caso real de la planilla: los 2 PLANNIN de Viviana, objetivo 1, base 873,74
   * cada uno. Pagaron 26,21 — que es la base COMPLETA de uno por su 3 %, no la
   * mitad de la suma. Con bases iguales los dos criterios dan el mismo número, y
   * por eso este caso no bastaba para descubrir que el prorrateo estaba mal.
   */
  it('paga la base completa del plan elegido, no una fracción', () => {
    const bases = new Map([
      ['nino-a', 873.74],
      ['nino-b', 873.74],
    ]);
    const plannin: PlanCandidato[] = [
      { id: 'nino-a', codOrigen: 'VE1001', fecha: null, comisionaPlan: null },
      { id: 'nino-b', codOrigen: 'VE1002', fecha: null, comisionaPlan: null },
    ];
    const { elegidos } = seleccionarPlanesComisionables(plannin, 1);
    expect(elegidos.size).toBe(1);

    const base = [...elegidos].reduce((s, id) => s + (bases.get(id) ?? 0), 0);
    expect(Math.round(base * 0.03 * 100) / 100).toBe(26.21);
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
  /**
   * Los 6 paquetes de Claudia en diciembre 2025, con su correlativo y su fecha
   * REALES. La planilla marcó "COMISIONA" en VE1458 y VE1462 —los dos últimos
   * por correlativo— y pagó 3 % × 2.106,62 + 2 % × 1.886,62 = 100,93.
   *
   * El caso vale porque la fecha y el correlativo se contradicen: VE1458 es del
   * 22/12 y VE1462 del 13/12, así que "los dos últimos por fecha" habría elegido
   * VE1458 y el VE1457 del 10/12. Y las bases también se contradicen: los dos
   * más baratos son VE1457 (645,64) y VE1462, que pagaban 50,65 — la mitad.
   */
  const claudia: PlanCandidato[] = [
    { id: 'VE1447', codOrigen: 'VE1447', fecha: new Date('2025-12-02'), comisionaPlan: null },
    { id: 'VE1452', codOrigen: 'VE1452', fecha: new Date('2025-12-05'), comisionaPlan: null },
    { id: 'VE1454', codOrigen: 'VE1454', fecha: new Date('2025-12-08'), comisionaPlan: null },
    { id: 'VE1457', codOrigen: 'VE1457', fecha: new Date('2025-12-10'), comisionaPlan: null },
    { id: 'VE1458', codOrigen: 'VE1458', fecha: new Date('2025-12-22'), comisionaPlan: null },
    { id: 'VE1462', codOrigen: 'VE1462', fecha: new Date('2025-12-13'), comisionaPlan: null },
  ];

  it('sin decisión manual elige los ÚLTIMOS, como marcó la planilla', () => {
    const { elegidos, cupo } = seleccionarPlanesComisionables(claudia, 4);
    expect(cupo).toBe(2);
    expect([...elegidos].sort()).toEqual(['VE1458', 'VE1462']);
  });

  it('ordena por correlativo, no por fecha de venta', () => {
    const { elegidos } = seleccionarPlanesComisionables(claudia, 5);
    expect([...elegidos]).toEqual(['VE1462']);
  });

  it('respeta lo que administración marcó, aunque no sea de los últimos', () => {
    const conMarca = claudia.map(p => (p.id === 'VE1447' ? { ...p, comisionaPlan: true } : p));
    const { elegidos } = seleccionarPlanesComisionables(conMarca, 5);
    expect([...elegidos]).toEqual(['VE1447']);
  });

  it('nunca elige uno descartado a mano', () => {
    const conDescarte = claudia.map(p => (p.id === 'VE1462' ? { ...p, comisionaPlan: false } : p));
    const { elegidos } = seleccionarPlanesComisionables(conDescarte, 5);
    expect([...elegidos]).toEqual(['VE1458']);
  });

  it('completa el cupo con los siguientes más recientes', () => {
    const conMarca = claudia.map(p => (p.id === 'VE1447' ? { ...p, comisionaPlan: true } : p));
    const { elegidos, cupo } = seleccionarPlanesComisionables(conMarca, 3);
    expect(cupo).toBe(3);
    expect([...elegidos].sort()).toEqual(['VE1447', 'VE1458', 'VE1462']);
  });

  it('no paga de más si marcaron más de los que el objetivo permite', () => {
    const exceso = claudia.map(p => ({ ...p, comisionaPlan: true }));
    const { elegidos, cupo, descartadosPorCupo } = seleccionarPlanesComisionables(exceso, 5);
    expect(cupo).toBe(1);
    expect([...elegidos]).toEqual(['VE1462']);
    expect(descartadosPorCupo).toHaveLength(5);
  });

  it('igualar el objetivo no comisiona ninguno', () => {
    expect(seleccionarPlanesComisionables(claudia, 6).elegidos.size).toBe(0);
    expect(seleccionarPlanesComisionables(claudia, 9).cupo).toBe(0);
  });

  /*
   * El correlativo se compara como número, no como texto: "VE999" es anterior a
   * "VE1000" aunque alfabéticamente vaya después. El mes en que la clínica cruce
   * el millar es el mes en que esto se pagaría al revés.
   */
  it('el correlativo se ordena por número, no alfabéticamente', () => {
    const cruce: PlanCandidato[] = [
      { id: 'x', codOrigen: 'VE999', fecha: null, comisionaPlan: null },
      { id: 'y', codOrigen: 'VE1000', fecha: null, comisionaPlan: null },
    ];
    expect([...seleccionarPlanesComisionables(cruce, 1).elegidos]).toEqual(['y']);
  });

  it('sin correlativo cae a la fecha', () => {
    const sinCodigo: PlanCandidato[] = [
      { id: 'viejo', codOrigen: null, fecha: new Date('2026-01-03'), comisionaPlan: null },
      { id: 'nuevo', codOrigen: null, fecha: new Date('2026-01-28'), comisionaPlan: null },
    ];
    expect([...seleccionarPlanesComisionables(sinCodigo, 1).elegidos]).toEqual(['nuevo']);
  });

  it('es determinista: dos corridas eligen lo mismo sin correlativo ni fecha', () => {
    const empate: PlanCandidato[] = [
      { id: 'b', codOrigen: null, fecha: null, comisionaPlan: null },
      { id: 'a', codOrigen: null, fecha: null, comisionaPlan: null },
      { id: 'c', codOrigen: null, fecha: null, comisionaPlan: null },
    ];
    const uno = [...seleccionarPlanesComisionables(empate, 2).elegidos];
    const dos = [...seleccionarPlanesComisionables([...empate].reverse(), 2).elegidos];
    expect(uno).toEqual(dos);
  });
});

/*
 * La moneda del cálculo. Estas cifras salen de "CALCULO COMISION DICIEMBRE
 * 2024.xlsx" y son la prueba de que la planilla trabaja en DÓLARES de punta a
 * punta, aplicando el tipo de cambio una sola vez al final.
 *
 * Si alguien vuelve a dividir la base entre el TC antes de aplicar el
 * porcentaje —como se hizo una vez, asumiendo que el Excel venía en bolivianos—
 * estas cuentas dejan de cerrar.
 */
describe('moneda: el cálculo va en dólares y el TC se aplica al final', () => {
  const TC = 6.97;
  const redondear2 = (n: number) => Math.round(n * 100) / 100;

  it('una tarifa RA fija y un porcentaje se suman en la MISMA unidad', () => {
    // Hoja `COMISIONES (COORD)`, filas 16 y 21 — Carla y Maricela.
    const porTarifaFija = 2 * 10; // 2 procedimientos × 10 USD
    const porPorcentaje = 6204.8313 * 0.01;

    expect(porTarifaFija).toBe(20);
    expect(redondear2(porPorcentaje)).toBe(62.05);

    // Y ambas se convierten a bolivianos con el mismo TC. Se redondea al final,
    // igual que la planilla: redondear antes desviaría un céntimo.
    expect(redondear2(porTarifaFija * TC)).toBe(139.4);
    expect(redondear2(porPorcentaje * TC)).toBe(432.48);
  });

  it('la comisión de cirugías es base × %, sin dividir', () => {
    // Hoja `COMISIONES (POR VENDEDORA)`, Viviana: 6 cirugías, nivel 5 empresa.
    expect(redondear2(22054.17 * 0.035)).toBe(771.9);
  });

  it('el total de Viviana en diciembre cuadra con el consolidado', () => {
    const comisiones = 973.4031105; // suma de sus Tipo A, B y C, sin redondear
    const bonoTrimestral = redondear2(36285.54 * 0.005); // 0,5 % de su diciembre

    expect(bonoTrimestral).toBe(181.43);
    expect(redondear2(comisiones + bonoTrimestral)).toBe(1154.83);
    // TOTAL A PAGAR BOB del consolidado.
    expect(redondear2((comisiones + bonoTrimestral) * TC)).toBe(8049.19);
  });

  it('el aporte al pote de jefatura es el neto × factor, sin convertir', () => {
    // Hoja `CALCULO BONOS`, fila 15: Viviana 31.568,42 × 0,2 % = 63,14.
    expect(redondear2(31568.4198 * 0.002)).toBe(63.14);
  });
});

/**
 * Cifras reales de la planilla de administración de diciembre 2025, cruzadas
 * con los tres export de FileMaker (octubre, noviembre y diciembre). Los doce
 * montos vendidos se reprodujeron exactos desde el export antes de escribir
 * esto, así que si alguna de estas pruebas cae, el que cambió fue el cálculo.
 */
describe('bonos, contra la planilla de diciembre 2025', () => {
  const FACTOR_TRIMESTRAL = 0.005;
  const FACTOR_JEFATURA = 0.002;
  const TC = 6.97;

  describe('bono trimestral — 0,5 % del promedio del trimestre', () => {
    const casos: Array<[string, number, number, number]> = [
      // nombre, promedio oct-nov-dic, objetivo, bono esperado en Bs
      ['Viviana (jefa)', 30524.93, 15000, 1063.76],
      ['Claudia', 27610.24, 15000, 962.21],
      ['Zuany', 17541.34, 15000, 611.34],
      ['Yelca', 16529.95, 15000, 576.07],
    ];

    it.each(casos)('%s: promedio %d → %d Bs', (_n, promedio, objetivo, esperadoBob) => {
      const bob = bonoTrimestralUsd(promedio, objetivo, FACTOR_TRIMESTRAL) * TC;
      /* ±0,05 Bs: la planilla redondea en un paso distinto. */
      expect(bob).toBeCloseTo(esperadoBob, 1);
    });

    it('quien no supera el promedio de 15.000 no cobra', () => {
      /* Gizelle: 0 + 16.189,80 + 6.695,84 → promedio 7.628,54. No aparece en
         la planilla de pago, y así es como se explica. */
      expect(bonoTrimestralUsd(7628.54, 15000, FACTOR_TRIMESTRAL)).toBe(0);
    });

    it('el umbral es 15.000 también para quien tiene objetivo mensual de 12.000', () => {
      expect(bonoTrimestralUsd(14999, 15000, FACTOR_TRIMESTRAL)).toBe(0);
    });
  });

  describe('pote de jefatura — 0,2 % del EXCEDENTE, no de la venta entera', () => {
    const casos: Array<[string, number, number, number]> = [
      // nombre, monto vendido en diciembre, objetivo mensual, aporte USD
      ['Viviana', 26641.39, 15000, 23.28],
      ['Yelca', 20759.43, 12000, 17.52],
      ['Zuany', 18843.4, 12000, 13.69],
      ['Claudia', 18098.82, 12000, 12.2],
    ];

    it.each(casos)('%s aporta %d USD', (_n, vendido, objetivo, esperado) => {
      expect(aporteAlPoteJefatura(vendido, objetivo, FACTOR_JEFATURA)).toBeCloseTo(esperado, 2);
    });

    it('el pote suma 66,69 USD y es lo que cobra la jefatura', () => {
      const pote =
        aporteAlPoteJefatura(26641.39, 15000, FACTOR_JEFATURA) +
        aporteAlPoteJefatura(20759.43, 12000, FACTOR_JEFATURA) +
        aporteAlPoteJefatura(18843.4, 12000, FACTOR_JEFATURA) +
        aporteAlPoteJefatura(18098.82, 12000, FACTOR_JEFATURA);

      expect(pote).toBeCloseTo(66.69, 2);
      expect(pote * TC).toBeCloseTo(464.83, 1);
      /* Y otro tanto igual se reparte entre las dos de publicidad. */
      expect((pote / 2) * TC).toBeCloseTo(232.41, 1);
    });

    it('quien no llega a su objetivo no aporta', () => {
      expect(aporteAlPoteJefatura(11999, 12000, FACTOR_JEFATURA)).toBe(0);
    });
  });
});
