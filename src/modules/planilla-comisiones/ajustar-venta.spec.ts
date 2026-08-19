import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

import { PlanillaComisionesService } from './planilla-comisiones.service';

/**
 * Quitarle la comisión a una venta es mover dinero de una persona.
 *
 * Hasta ahora el backend lo permitía —el DTO ya aceptaba `comisionable`— pero
 * sin pedir explicación, y la interfaz ni siquiera lo ofrecía. Lo que se fija
 * aquí es que no se pueda excluir en silencio: sin motivo no pasa, y volver a
 * incluir limpia el motivo para que una fila no aparezca comisionando y
 * "excluida por X" a la vez.
 *
 * Son pruebas de la REGLA, no de Prisma: el cliente es un doble que devuelve lo
 * que se le pide y registra con qué se le llamó. La suite de integración cubre
 * lo que necesita base real.
 */

interface VentaFalsa {
  id: string;
  periodoId: string;
}

function montar(opciones: { estadoPeriodo?: string; venta?: VentaFalsa | null } = {}) {
  const venta = opciones.venta === undefined ? { id: 'v1', periodoId: 'p1' } : opciones.venta;
  const actualizaciones: Array<Record<string, unknown>> = [];
  const auditorias: Array<{ accion: string; datos: unknown }> = [];

  const prisma = {
    ventaImportada: {
      findUnique: async () => venta,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        actualizaciones.push(data);
        return { ...venta, ...data };
      },
    },
    periodoComision: {
      findUnique: async () => ({
        id: 'p1',
        estado: opciones.estadoPeriodo ?? 'BORRADOR',
        anio: 2026,
        mes: 1,
      }),
    },
    vendedoraComision: { count: async () => 1 },
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
    { invalidar: () => undefined } as never,
  );

  return { servicio, actualizaciones, auditorias };
}

describe('ajustarVenta · excluir del cálculo', () => {
  it('sin motivo NO deja excluir', async () => {
    const { servicio, actualizaciones } = montar();

    await expect(servicio.ajustarVenta('v1', { comisionable: false }, 'u1')).rejects.toThrow(
      BadRequestException,
    );
    /* Y no escribe nada: la fila se queda como estaba. */
    expect(actualizaciones).toHaveLength(0);
  });

  it.each(['', '   '])('un motivo vacío (%p) tampoco vale', async motivo => {
    const { servicio } = montar();
    await expect(
      servicio.ajustarVenta('v1', { comisionable: false, motivoExclusion: motivo }, 'u1'),
    ).rejects.toThrow(BadRequestException);
  });

  it('con motivo excluye y lo guarda', async () => {
    const { servicio, actualizaciones } = montar();

    await servicio.ajustarVenta(
      'v1',
      { comisionable: false, motivoExclusion: 'Devolución de la paciente' },
      'u1',
    );

    expect(actualizaciones[0]).toMatchObject({
      comisionable: false,
      motivoExclusion: 'Devolución de la paciente',
      ajustadaManual: true,
    });
  });

  /* El motivo tiene que llegar a la auditoría: es la única forma de saber
     después quién la excluyó y por qué. */
  it('el motivo queda en el registro de auditoría', async () => {
    const { servicio, auditorias } = montar();

    await servicio.ajustarVenta(
      'v1',
      { comisionable: false, motivoExclusion: 'Cobrada dos veces' },
      'u1',
    );

    expect(auditorias[0].accion).toBe('AJUSTAR');
    expect(auditorias[0].datos).toMatchObject({ motivoExclusion: 'Cobrada dos veces' });
  });

  /* Sin esto, una fila reincluida seguiría mostrando el motivo por el que un día
     se excluyó: comisionando y "excluida por devolución" a la vez. */
  it('volver a incluir borra el motivo', async () => {
    const { servicio, actualizaciones } = montar();

    await servicio.ajustarVenta('v1', { comisionable: true }, 'u1');

    expect(actualizaciones[0]).toMatchObject({ comisionable: true, motivoExclusion: null });
  });

  it('un cambio que no toca la comisión no exige motivo', async () => {
    const { servicio, actualizaciones } = montar();

    await servicio.ajustarVenta('v1', { clasif: 'LAB' } as never, 'u1');

    expect(actualizaciones[0]).toMatchObject({ clasif: 'LAB', requiereRevision: false });
  });

  /* Un periodo cerrado ya se pagó: no se le tocan las cifras. */
  it('en un periodo CERRADO no se puede excluir nada', async () => {
    const { servicio } = montar({ estadoPeriodo: 'CERRADO' });

    await expect(
      servicio.ajustarVenta('v1', { comisionable: false, motivoExclusion: 'x y z' }, 'u1'),
    ).rejects.toThrow(ConflictException);
  });

  it('una venta que no existe da 404', async () => {
    const { servicio } = montar({ venta: null });

    await expect(servicio.ajustarVenta('nope', { comisionable: true }, 'u1')).rejects.toThrow(
      NotFoundException,
    );
  });
});
