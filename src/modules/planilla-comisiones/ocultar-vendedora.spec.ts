import { BadRequestException, NotFoundException } from '@nestjs/common';

import { PlanillaComisionesService } from './planilla-comisiones.service';

/**
 * Ocultar a una vendedora la borra de la planilla que administración firma.
 *
 * No borra un dato —sus ventas y sus liquidaciones siguen intactas— pero sí
 * hace que una persona deje de aparecer donde antes aparecía, y eso, meses
 * después, es indistinguible de un error de cálculo si nadie escribió por qué.
 * Por eso vale la misma regla que para excluir una venta (`ajustar-venta.spec`):
 * sin motivo no se oculta, y volver a mostrarla limpia el motivo para que no
 * quede figurando en los informes y "oculta por despido" a la vez.
 *
 * Son pruebas de la REGLA, no de Prisma: el cliente es un doble que devuelve lo
 * que se le pide y registra con qué se le llamó.
 */

interface VendedoraFalsa {
  id: string;
  nombre: string;
  oculta: boolean;
  motivoOculta: string | null;
  ocultaDesde: Date | null;
}

function montar(opciones: { vendedora?: VendedoraFalsa | null } = {}) {
  const vendedora =
    opciones.vendedora === undefined
      ? { id: 'v1', nombre: 'Yelca', oculta: false, motivoOculta: null, ocultaDesde: null }
      : opciones.vendedora;

  const actualizaciones: Array<Record<string, unknown>> = [];
  const auditorias: Array<{ accion: string; datos: unknown }> = [];

  const prisma = {
    vendedoraComision: {
      findUnique: async () => vendedora,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        actualizaciones.push(data);
        return { ...vendedora, ...data };
      },
    },
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

  return { servicio, actualizaciones, auditorias };
}

describe('actualizarVendedora · ocultar de los informes', () => {
  it('sin motivo NO deja ocultar', async () => {
    const { servicio, actualizaciones } = montar();

    await expect(servicio.actualizarVendedora('v1', { oculta: true }, 'u1')).rejects.toThrow(
      BadRequestException,
    );
    /* Y no escribe nada: la vendedora se queda como estaba. */
    expect(actualizaciones).toHaveLength(0);
  });

  it.each(['', '   '])('un motivo vacío (%p) tampoco vale', async motivo => {
    const { servicio } = montar();

    await expect(
      servicio.actualizarVendedora('v1', { oculta: true, motivoOculta: motivo }, 'u1'),
    ).rejects.toThrow(BadRequestException);
  });

  it('con motivo la oculta, lo guarda y fecha la baja', async () => {
    const { servicio, actualizaciones } = montar();

    await servicio.actualizarVendedora(
      'v1',
      { oculta: true, motivoOculta: 'Ya no trabaja en la clínica' },
      'u1',
    );

    expect(actualizaciones[0]).toMatchObject({
      oculta: true,
      motivoOculta: 'Ya no trabaja en la clínica',
    });
    expect(actualizaciones[0]['ocultaDesde']).toBeInstanceOf(Date);
  });

  /* El motivo se recorta: un espacio de más no puede cambiar lo que se lee en
     el informe exportado, que lo imprime tal cual. */
  it('el motivo se guarda sin espacios de sobra', async () => {
    const { servicio, actualizaciones } = montar();

    await servicio.actualizarVendedora('v1', { oculta: true, motivoOculta: '  Despido  ' }, 'u1');

    expect(actualizaciones[0]).toMatchObject({ motivoOculta: 'Despido' });
  });

  it('el motivo queda en el registro de auditoría', async () => {
    const { servicio, auditorias } = montar();

    await servicio.actualizarVendedora('v1', { oculta: true, motivoOculta: 'Renunció' }, 'u1');

    expect(auditorias[0].accion).toBe('ACTUALIZAR');
    expect(auditorias[0].datos).toMatchObject({ motivoOculta: 'Renunció' });
  });

  /* Sin esto, una vendedora devuelta a los informes seguiría arrastrando el
     motivo por el que un día se la ocultó: listada y "de baja por despido" a la
     vez, que es la misma incoherencia que se arregló en las ventas reincluidas. */
  it('volver a mostrarla borra el motivo y la fecha', async () => {
    const { servicio, actualizaciones } = montar({
      vendedora: {
        id: 'v1',
        nombre: 'Yelca',
        oculta: true,
        motivoOculta: 'Despido',
        ocultaDesde: new Date('2026-03-01'),
      },
    });

    await servicio.actualizarVendedora('v1', { oculta: false }, 'u1');

    expect(actualizaciones[0]).toMatchObject({
      oculta: false,
      motivoOculta: null,
      ocultaDesde: null,
    });
  });

  /* Un PATCH de sueldo o de área no puede tocar la visibilidad de rebote. */
  it('un cambio que no toca la visibilidad la deja intacta', async () => {
    const { servicio, actualizaciones } = montar();

    await servicio.actualizarVendedora('v1', { sueldoBase: 2750 }, 'u1');

    expect(actualizaciones[0]).toMatchObject({ sueldoBase: 2750, configurada: true });
    expect(actualizaciones[0]).not.toHaveProperty('oculta');
    expect(actualizaciones[0]).not.toHaveProperty('ocultaDesde');
  });

  /* `motivoOculta` suelto no significa nada: sin `oculta` no se escribe. Si se
     colara por el spread del DTO, la ficha mostraría "de baja por X" sobre una
     vendedora que sigue en todos los informes. */
  it('un motivo sin ocultar a nadie no se guarda', async () => {
    const { servicio, actualizaciones } = montar();

    await servicio.actualizarVendedora('v1', { motivoOculta: 'Despido' }, 'u1');

    expect(actualizaciones[0]).not.toHaveProperty('motivoOculta');
  });

  /* Ocultar dos veces no debe re-fechar la baja: la fecha es la del día en que
     se fue, no la del último clic en el panel. */
  it('volver a ocultar a quien ya está oculta no re-escribe la fecha', async () => {
    const { servicio, actualizaciones } = montar({
      vendedora: {
        id: 'v1',
        nombre: 'Yelca',
        oculta: true,
        motivoOculta: 'Despido',
        ocultaDesde: new Date('2026-03-01'),
      },
    });

    await servicio.actualizarVendedora('v1', { oculta: true, motivoOculta: 'Despido' }, 'u1');

    expect(actualizaciones[0]).not.toHaveProperty('ocultaDesde');
  });

  it('una vendedora que no existe da 404', async () => {
    const { servicio } = montar({ vendedora: null });

    await expect(servicio.actualizarVendedora('nope', { oculta: false }, 'u1')).rejects.toThrow(
      NotFoundException,
    );
  });
});
