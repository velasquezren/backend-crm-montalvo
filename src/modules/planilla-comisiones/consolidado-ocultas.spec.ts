import { CalculoComisionesService } from './calculo-comisiones.service';

/**
 * `reporteConsolidado()` es el ÚNICO sitio donde se decide si una vendedora dada
 * de baja aparece en un informe: de él salen la planilla de la pantalla, el
 * desglose de Reportes, `reportePlanilla`, `reporteBonos` y las cuatro hojas
 * "por persona" del Excel que se firma. Por eso se prueba acá y no en cada
 * consumidor.
 *
 * Lo que se fija:
 *
 * 1. Por defecto la dada de baja NO sale.
 * 2. **Los totales se recalculan sobre lo que se devuelve.** Un pie que sigue
 *    sumando a quien no está listada es un informe que no cuadra consigo mismo,
 *    y es el fallo que un filtro puesto solo en la plantilla habría dejado.
 * 3. Se puede decir cuántas y cuáles se dejaron fuera, aunque no se listen.
 * 4. Con `incluirOcultas` vuelven, para reeditar un mes en el que sí trabajaba.
 *
 * Son pruebas de la REGLA: el cliente de Prisma es un doble.
 */

interface ResultadoFalso {
  vendedoraId: string;
  nombre: string;
  oculta: boolean;
  totalUsd: number;
  totalBob: number;
  totalGanado: number;
}

/** Un `ResultadoComision` con todo lo que el reporte lee, en cero salvo dinero. */
function resultado(r: ResultadoFalso) {
  return {
    vendedoraId: r.vendedoraId,
    montoVendido: r.totalUsd * 10,
    baseCalculo: r.totalUsd * 8.7,
    planesVendidos: 0,
    cumpleObjetivoPlanes: false,
    planpaqVendidos: 0,
    planpaqComisionables: 0,
    planninVendidos: 0,
    planninComisionables: 0,
    acumuladoCirugias: 0,
    nivelCirugia: null,
    ingresoMaternidadTipoARA: 0,
    ingresoRATipoARA: 0,
    excedenteTipoARA: 0,
    nivelTipoARA: null,
    comisionA: r.totalUsd,
    comisionB: 0,
    comisionC: 0,
    comisionTipoARA: 0,
    bonoJefatura: 0,
    bonoPublicidad: 0,
    bonoTrimestral: 0,
    totalUsd: r.totalUsd,
    totalBob: r.totalBob,
    sueldoBase: 0,
    totalGanado: r.totalGanado,
    vendedora: {
      id: r.vendedoraId,
      nombre: r.nombre,
      codigo: `C${r.vendedoraId}`,
      tipo: 'VENDEDORA',
      area: 'EJECUTIVA',
      oculta: r.oculta,
      ocultaDesde: r.oculta ? new Date('2026-03-01') : null,
      motivoOculta: r.oculta ? 'Ya no trabaja en la clínica' : null,
    },
  };
}

const EN_EQUIPO = {
  vendedoraId: 'v1',
  nombre: 'Zuany',
  oculta: false,
  totalUsd: 100,
  totalBob: 697,
  totalGanado: 697,
};
const DADA_DE_BAJA = {
  vendedoraId: 'v2',
  nombre: 'Yelca',
  oculta: true,
  totalUsd: 40,
  totalBob: 278.8,
  totalGanado: 278.8,
};

function montar() {
  const prisma = {
    periodoComision: { findUnique: async () => ({ id: 'p1', anio: 2026, mes: 1, tipoCambio: 6.97 }) },
    resultadoComision: {
      findMany: async () => [resultado(EN_EQUIPO), resultado(DADA_DE_BAJA)],
    },
  };

  return new CalculoComisionesService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

describe('reporteConsolidado · vendedoras dadas de baja', () => {
  it('por defecto no las lista', async () => {
    const rep = await montar().reporteConsolidado('p1');

    expect(rep.filas.map(f => f.nombre)).toEqual(['Zuany']);
    expect(rep.incluyeOcultas).toBe(false);
  });

  /* La prueba que atrapa el fallo de filtrar solo en la plantilla: el pie del
     informe tiene que ser la suma de las filas que se ven, no del mes entero. */
  it('los totales son la suma EXACTA de las filas listadas', async () => {
    const rep = await montar().reporteConsolidado('p1');

    expect(rep.totales['totalUsd']).toBe(100);
    expect(rep.totales['totalBob']).toBe(697);
    expect(rep.totales['totalGanado']).toBe(697);
  });

  /* Que no se listen no puede significar que nadie sepa que faltan. */
  it('dice cuáles se dejaron fuera, con su motivo y lo que habrían cobrado', async () => {
    const rep = await montar().reporteConsolidado('p1');

    expect(rep.ocultas).toHaveLength(1);
    expect(rep.ocultas[0]).toMatchObject({
      nombre: 'Yelca',
      motivoOculta: 'Ya no trabaja en la clínica',
      totalGanado: 278.8,
    });
  });

  it('con incluirOcultas vuelven, marcadas, y los totales las suman', async () => {
    const rep = await montar().reporteConsolidado('p1', true);

    expect(rep.filas.map(f => f.nombre).sort()).toEqual(['Yelca', 'Zuany']);
    expect(rep.filas.find(f => f.nombre === 'Yelca')?.oculta).toBe(true);
    expect(rep.incluyeOcultas).toBe(true);
    expect(rep.totales['totalUsd']).toBe(140);
    expect(rep.totales['totalGanado']).toBe(975.8);
  });

  /* La lista de excluidas sigue viajando: la pantalla la usa para ofrecer el
     interruptor de "volver a ocultarlas" sin pedir el informe otra vez. */
  it('la lista de dadas de baja llega también cuando se las incluye', async () => {
    const rep = await montar().reporteConsolidado('p1', true);

    expect(rep.ocultas.map(v => v.nombre)).toEqual(['Yelca']);
  });
});
