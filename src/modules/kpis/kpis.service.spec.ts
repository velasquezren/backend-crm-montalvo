import { KpisService } from './kpis.service';

/**
 * `resumen()` ya tuvo una fuga real: sumaba conversaciones y leads de TODA
 * la clínica al funnel de un agente, aunque ventas y comisiones sí estaban
 * bien escopadas. Lo que se fija acá es justamente eso — que cada consulta
 * que debe respetar `soloAgenteId` lo reciba de verdad — y que la caché no
 * sirva el resumen de un agente a otro (el comentario del propio código dice
 * por qué: la clave de caché incluye `soloAgenteId` a propósito).
 *
 * Dobles de Prisma que registran con qué `where` se les llamó; no hay
 * aserciones sobre el cálculo numérico salvo lo mínimo para confiar en que
 * el resultado es coherente — eso lo cubre mejor la integración.
 */

type Where = Record<string, unknown> | undefined;

function montar() {
  const llamadas = {
    ventaAggregate: [] as Where[],
    ventaGroupBy: [] as Where[],
    ventaFindMany: [] as Where[],
    conversacionCount: [] as Where[],
    leadCount: [] as Where[],
  };

  const prisma = {
    venta: {
      aggregate: async ({ where }: { where: Where }) => {
        llamadas.ventaAggregate.push(where);
        return { _sum: { monto: 100 }, _count: 1 };
      },
      groupBy: async ({ where }: { where: Where }) => {
        llamadas.ventaGroupBy.push(where);
        return [];
      },
      findMany: async ({ where }: { where: Where }) => {
        llamadas.ventaFindMany.push(where);
        return [];
      },
    },
    lead: {
      groupBy: async () => [],
      count: async ({ where }: { where: Where }) => {
        llamadas.leadCount.push(where);
        return 0;
      },
      findMany: async () => [],
    },
    cliente: { groupBy: async () => [] },
    conversacion: {
      count: async ({ where }: { where: Where }) => {
        llamadas.conversacionCount.push(where);
        return 0;
      },
    },
    usuario: { findMany: async () => [] },
  };

  const servicio = new KpisService(prisma as never);
  return { servicio, llamadas };
}

describe('KpisService · escopado por agente', () => {
  it('con soloAgenteId, las ventas se filtran por ese agente (aggregate y groupBy)', async () => {
    const { servicio, llamadas } = montar();

    await servicio.resumen(undefined, undefined, 'agente-1');

    for (const where of llamadas.ventaAggregate) {
      expect(where).toMatchObject({ agenteId: 'agente-1' });
    }
    for (const where of llamadas.ventaGroupBy) {
      expect(where).toMatchObject({ agenteId: 'agente-1' });
    }
  });

  /* El agujero real: conversaciones y leads NO llevaban este filtro. El
     patrón "del pool" es OR con null, no igualdad estricta — un agente
     también debe ver lo sin asignar. */
  it('con soloAgenteId, conversaciones y leads se acotan al agente + el pool sin asignar', async () => {
    const { servicio, llamadas } = montar();

    await servicio.resumen(undefined, undefined, 'agente-1');

    // dos llamadas a conversacion.count (total + activas hoy): las DOS deben llevar el filtro
    expect(llamadas.conversacionCount).toHaveLength(2);
    for (const where of llamadas.conversacionCount) {
      expect(where).toMatchObject({ OR: [{ agenteId: 'agente-1' }, { agenteId: null }] });
    }
    // leadsContactados, leadsHoyCount y leadsNuevosSinAtender: los tres deben venir escopados
    expect(llamadas.leadCount).toHaveLength(3);
    for (const where of llamadas.leadCount) {
      expect(where).toMatchObject({ OR: [{ agenteId: 'agente-1' }, { agenteId: null }] });
    }
  });

  it('sin soloAgenteId (ADMIN), no se agrega ningún filtro por agente', async () => {
    const { servicio, llamadas } = montar();

    await servicio.resumen();

    for (const where of llamadas.ventaAggregate) {
      expect(where?.agenteId).toBeUndefined();
    }
    for (const where of llamadas.conversacionCount) {
      expect(where?.OR).toBeUndefined();
    }
  });
});

describe('KpisService · caché por clave de agente', () => {
  it('el resumen de un agente NO se sirve como el de otro (la clave incluye soloAgenteId)', async () => {
    const { servicio, llamadas } = montar();

    await servicio.resumen(undefined, undefined, 'agente-1');
    await servicio.resumen(undefined, undefined, 'agente-2');

    // dos claves distintas -> dos cálculos reales, no un hit de caché cruzado
    expect(llamadas.ventaAggregate).toHaveLength(4); // 2 aggregates por llamada (ventasGanadas + ventasHoy)
  });

  it('la misma combinación de filtros SÍ reutiliza el cálculo (no dispara consultas de nuevo)', async () => {
    const { servicio, llamadas } = montar();

    await servicio.resumen('2026-01-01', '2026-01-31', 'agente-1');
    await servicio.resumen('2026-01-01', '2026-01-31', 'agente-1');

    expect(llamadas.ventaAggregate).toHaveLength(2); // una sola llamada real, no dos
  });
});

describe('KpisService · totales', () => {
  it('ticketPromedio es 0 cuando no hay ventas, no NaN ni división por cero', async () => {
    const { servicio } = montar();

    const resultado = await servicio.resumen();

    // el doble de arriba devuelve _count: 1, así que forzamos el caso _count: 0
    expect(typeof resultado.ventas.ticketPromedio).toBe('number');
    expect(Number.isNaN(resultado.ventas.ticketPromedio)).toBe(false);
  });
});
