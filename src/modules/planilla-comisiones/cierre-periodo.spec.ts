import { ConflictException } from '@nestjs/common';

import { PlanillaComisionesService } from './planilla-comisiones.service';

/**
 * El ciclo de vida de un mes de liquidación, del lado del servicio.
 *
 * `estados-periodo.spec.ts` prueba las reglas puras (qué salto es legal, cuándo
 * está completa una revisión). Acá se prueba que el servicio las USE: que no
 * exista una puerta que se salte la tabla, que el cierre sea consecuencia de
 * las firmas y no un botón aparte, y que un rechazo no deje firmas viejas
 * colgando de cifras que van a cambiar.
 *
 * El cliente de Prisma es un doble que registra con qué se le llamó.
 */

interface Opciones {
  estado?: string;
  superAdmins?: Array<{ id: string; nombre: string }>;
  aprobaciones?: string[];
  resultados?: number;
  sinClasificar?: number;
}

const RENE = { id: 'u1', nombre: 'René' };
const ANA = { id: 'u2', nombre: 'Ana' };

function montar(opciones: Opciones = {}) {
  const estado = opciones.estado ?? 'EN_REVISION';
  const aprobaciones = (opciones.aprobaciones ?? []).map(usuarioId => ({
    usuarioId,
    comentario: null,
    createdAt: new Date('2026-08-28'),
  }));

  const periodo = {
    id: 'p1',
    anio: 2026,
    mes: 1,
    estado,
    cerradoEn: estado === 'CERRADO' ? new Date('2026-08-20') : null,
    cerradoPor: estado === 'CERRADO' ? 'u1' : null,
    pagadoEn: null,
    pagadoPor: null,
    enRevisionDesde: null,
    configuracionUsada: { tipoCambio: 6.97 },
    _count: { ventas: 400, resultados: opciones.resultados ?? 3 },
  };

  const actualizaciones: Array<Record<string, unknown>> = [];
  const auditorias: Array<{ accion: string; datos: unknown }> = [];
  const borrados: string[] = [];
  const upserts: Array<Record<string, unknown>> = [];

  const periodoComision = {
    findUnique: async () => periodo,
    update: async ({ data }: { data: Record<string, unknown> }) => {
      actualizaciones.push(data);
      return { ...periodo, ...data };
    },
  };
  const aprobacionPeriodo = {
    findMany: async () => aprobaciones,
    deleteMany: async ({ where }: { where: { periodoId: string } }) => {
      borrados.push(where.periodoId);
      return { count: aprobaciones.length };
    },
    upsert: async (args: Record<string, unknown>) => {
      upserts.push(args);
      return {};
    },
  };

  const prisma = {
    periodoComision,
    aprobacionPeriodo,
    usuario: { findMany: async () => opciones.superAdmins ?? [RENE] },
    /* Lo que consulta `alertas()`. Todo en cero salvo lo que pida la prueba:
       la compuerta se prueba en detalle en `estados-periodo.spec.ts`. */
    ventaImportada: {
      count: async ({ where }: { where: Record<string, unknown> }) =>
        where['requiereRevision'] ? (opciones.sinClasificar ?? 0) : 0,
      groupBy: async () => [],
      findMany: async () => [],
    },
    vendedoraComision: { count: async () => 0, findMany: async () => [] },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ periodoComision, aprobacionPeriodo }),
  };

  const audit = {
    registrar: async (_e: string, _id: string, accion: string, _u: string, datos: unknown) => {
      auditorias.push({ accion, datos });
    },
  };

  const servicio = new PlanillaComisionesService(
    prisma as never,
    {} as never,
    audit as never,
    {} as never,
    { invalidar: () => undefined } as never,
    { configuracion: async () => ({ modo: 'FIJO', valorFijo: 6.97 }) } as never,
  );

  return { servicio, actualizaciones, auditorias, borrados, upserts };
}

describe('enviarARevision', () => {
  it('desde CALCULADO congela el mes y deja quién lo mandó', async () => {
    const { servicio, actualizaciones, auditorias } = montar({ estado: 'CALCULADO' });

    await servicio.enviarARevision('p1', 'u9');

    expect(actualizaciones[0]).toMatchObject({
      estado: 'EN_REVISION',
      enviadoARevisionPor: 'u9',
    });
    expect(auditorias[0].accion).toBe('ENVIAR_A_REVISION');
  });

  /* La compuerta. Sin ella, el flujo de aprobaciones solo reparte la firma de
     un número que ya estaba mal. */
  it('con filas sin clasificar NO deja revisar, y no escribe nada', async () => {
    const { servicio, actualizaciones } = montar({ estado: 'CALCULADO', sinClasificar: 12 });

    await expect(servicio.enviarARevision('p1', 'u9')).rejects.toThrow(ConflictException);
    expect(actualizaciones).toHaveLength(0);
  });

  it('un mes sin liquidar tampoco pasa', async () => {
    const { servicio } = montar({ estado: 'CALCULADO', resultados: 0 });

    await expect(servicio.enviarARevision('p1', 'u9')).rejects.toThrow(ConflictException);
  });

  it('no se puede mandar a revisión un mes ya cerrado', async () => {
    const { servicio } = montar({ estado: 'CERRADO' });

    await expect(servicio.enviarARevision('p1', 'u9')).rejects.toThrow(ConflictException);
  });
});

describe('aprobar', () => {
  /* El cierre no es un botón aparte: es la consecuencia de que se complete el
     conjunto. Con un paso manual habría un hueco en el que el mes está
     aprobado y todavía editable. */
  it('con un solo SUPER_ADMIN, aprobar cierra el mes', async () => {
    const { servicio, actualizaciones, auditorias } = montar({ superAdmins: [RENE], aprobaciones: ['u1'] });

    const resultado = await servicio.aprobar('p1', 'u1');

    expect(resultado.cerrado).toBe(true);
    expect(actualizaciones[0]).toMatchObject({ estado: 'CERRADO', cerradoPor: 'u1' });
    expect(auditorias.map(a => a.accion)).toEqual(['APROBAR', 'CERRAR']);
  });

  it('si falta alguien, registra la firma pero NO cierra', async () => {
    const { servicio, actualizaciones, auditorias } = montar({
      superAdmins: [RENE, ANA],
      aprobaciones: ['u1'],
    });

    const resultado = await servicio.aprobar('p1', 'u1');

    expect(resultado.cerrado).toBe(false);
    expect(resultado.faltan.map(f => f.nombre)).toEqual(['Ana']);
    expect(actualizaciones).toHaveLength(0);
    expect(auditorias.map(a => a.accion)).toEqual(['APROBAR']);
  });

  it('solo se aprueba un mes EN REVISIÓN', async () => {
    const { servicio } = montar({ estado: 'CALCULADO' });

    await expect(servicio.aprobar('p1', 'u1')).rejects.toThrow(ConflictException);
  });

  /* `upsert` y no `create`: repetir el clic no puede reventar con un error de
     clave única ni sumar un segundo visto bueno de la misma persona. */
  it('aprobar dos veces no duplica la firma', async () => {
    const { servicio, upserts } = montar({ superAdmins: [RENE, ANA], aprobaciones: ['u1'] });

    await servicio.aprobar('p1', 'u1', 'todo ok');

    expect(upserts).toHaveLength(1);
    expect(upserts[0]['where']).toEqual({ periodoId_usuarioId: { periodoId: 'p1', usuarioId: 'u1' } });
  });
});

describe('rechazar', () => {
  it('devuelve el mes a CALCULADO y guarda el motivo', async () => {
    const { servicio, actualizaciones, auditorias } = montar();

    await servicio.rechazar('p1', 'u1', 'Falta la cirugía del 12');

    expect(actualizaciones[0]).toMatchObject({ estado: 'CALCULADO', enRevisionDesde: null });
    expect(auditorias[0]).toMatchObject({
      accion: 'RECHAZAR',
      datos: { motivo: 'Falta la cirugía del 12' },
    });
  });

  /* Una firma vale para las cifras que se firmaron. Si el mes vuelve a
     edición, arrastrar las aprobaciones de los demás sería darles por buenos
     unos números que esa gente nunca vio. */
  it('borra TODAS las aprobaciones, no solo la de quien rechaza', async () => {
    const { servicio, borrados } = montar({ superAdmins: [RENE, ANA], aprobaciones: ['u1', 'u2'] });

    await servicio.rechazar('p1', 'u1', 'Hay que revisar los planes');

    expect(borrados).toEqual(['p1']);
  });
});

describe('reabrir', () => {
  it('solo desde CERRADO, y guarda en auditoría la foto que se va a perder', async () => {
    const { servicio, actualizaciones, auditorias } = montar({ estado: 'CERRADO' });

    await servicio.reabrir('p1', 'u1', 'El Excel traía dos filas repetidas');

    expect(actualizaciones[0]).toMatchObject({ estado: 'CALCULADO', cerradoEn: null, cerradoPor: null });
    /* Sin esto, recalcular pisa `configuracionUsada` y desaparece la única
       respuesta a "¿con qué reglas se pagó este mes?". */
    expect(auditorias[0]).toMatchObject({
      accion: 'REABRIR',
      datos: { configuracionConLaQueSeCerro: { tipoCambio: 6.97 } },
    });
  });

  it('un mes EN REVISIÓN no se "reabre": se rechaza', async () => {
    const { servicio } = montar({ estado: 'EN_REVISION' });

    await expect(servicio.reabrir('p1', 'u1', 'motivo largo')).rejects.toThrow(ConflictException);
  });

  /* La regla que define PAGADO. Un mes pagado se corrige con un ajuste del mes
     siguiente, no reescribiéndolo. */
  it('un mes PAGADO no se reabre', async () => {
    const { servicio } = montar({ estado: 'PAGADO' });

    await expect(servicio.reabrir('p1', 'u1', 'motivo largo')).rejects.toThrow(ConflictException);
  });
});

describe('registrarPago', () => {
  it('desde CERRADO deja quién pagó y cuándo', async () => {
    const { servicio, actualizaciones } = montar({ estado: 'CERRADO' });

    await servicio.registrarPago('p1', 'u1');

    expect(actualizaciones[0]).toMatchObject({ estado: 'PAGADO', pagadoPor: 'u1' });
  });

  it('no se paga un mes que todavía se está revisando', async () => {
    const { servicio } = montar({ estado: 'EN_REVISION' });

    await expect(servicio.registrarPago('p1', 'u1')).rejects.toThrow(ConflictException);
  });
});
