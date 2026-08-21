import { ResumenAnualService } from './resumen-anual.service';

/**
 * La caché del resumen anual, no el cálculo: este último lo cubre la suite de
 * integración contra base real. Lo que se fija aquí es lo que la caché puede
 * romper — servir un año viejo tras invalidar, o el año de UNA vendedora a
 * OTRA — que con datos de prueba en memoria se observa contando cuántas veces
 * se consulta la base.
 */

interface PrismaFalso {
  lecturasPeriodos: number;
}

function montar() {
  const lecturas: PrismaFalso = { lecturasPeriodos: 0 };

  const periodo = { id: 'p1', mes: 3, tipoCambio: 6.97, estado: 'CALCULADO' };
  const vendedoras = [
    { id: 'v1', codigo: 'VIVI', nombre: 'Viviana', tipo: 'JEFA', area: 'MATERNIDAD' },
    { id: 'v2', codigo: 'MARI', nombre: 'Maricela', tipo: 'EJECUTIVA', area: 'MATERNIDAD' },
  ];

  const prisma = {
    periodoComision: {
      findMany: async () => {
        lecturas.lecturasPeriodos++;
        return [periodo];
      },
    },
    /* El doble respeta el filtro que le llega: con `where.id` es el año de una
       vendedora, sin él, el del equipo completo. */
    vendedoraComision: {
      findMany: async ({ where }: { where?: { id?: string } }) =>
        where?.id ? vendedoras.filter(v => v.id === where.id) : vendedoras,
    },
    ventaImportada: {
      groupBy: async () => [{ periodoId: 'p1', vendedoraId: 'v1', _sum: { precio: 1000 } }],
    },
    resultadoComision: {
      findMany: async () => [],
    },
  };

  const configuracion = {
    cargarConfiguracion: async () => ({
      parametros: new Map(),
      objetivosPorTipo: new Map(),
    }),
  };

  const servicio = new ResumenAnualService(prisma as never, configuracion as never);
  return { servicio, lecturas };
}

describe('ResumenAnualService · caché', () => {
  it('el segundo pedido del mismo año no vuelve a la base', async () => {
    const { servicio, lecturas } = montar();

    await servicio.porAnio(2026);
    await servicio.porAnio(2026);

    expect(lecturas.lecturasPeriodos).toBe(1);
  });

  it('otro año (u otro escopado) es otra entrada: consulta de nuevo', async () => {
    const { servicio, lecturas } = montar();

    await servicio.porAnio(2026);
    await servicio.porAnio(2025);
    await servicio.porAnio(2026, 'v1');

    expect(lecturas.lecturasPeriodos).toBe(3);
  });

  /* El año con `soloVendedoraId` y el año completo comparten tabla pero no
     contenido: si la clave no los separara, la primera en cachearle a la
     segunda su versión recortada — el mismo agujero de escopado que tuvo
     `KpisService.resumen()`. */
  it('el año escopado a una vendedora no se le sirve a quien pide el completo', async () => {
    const { servicio } = montar();

    const escopado = await servicio.porAnio(2026, 'v1');
    const completo = await servicio.porAnio(2026);

    expect(escopado.filas).toHaveLength(1);
    expect(completo.filas).toHaveLength(2);
  });

  it('invalidar() fuerza la recarga: quien acaba de importar ve su mes', async () => {
    const { servicio, lecturas } = montar();

    await servicio.porAnio(2026);
    servicio.invalidar();
    await servicio.porAnio(2026);

    expect(lecturas.lecturasPeriodos).toBe(2);
  });
});
