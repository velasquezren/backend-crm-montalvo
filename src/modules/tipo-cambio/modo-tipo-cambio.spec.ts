import { ModoTipoCambio } from '../../prisma/prisma-client';

import { TipoCambioService } from './tipo-cambio.service';

/**
 * Con qué tipo de cambio convierte el CRM entre bolivianos y dólares.
 *
 * La clínica opera a un valor PACTADO (6,97): así se liquidaron los seis
 * periodos de 2026 y así viene el `tc` del Excel de FileMaker. El TCO oficial
 * del BCB se despegó —11,92 el 29/8/2026— y mientras `vigente()` devolvía la
 * serie diaria, el selector Bs/$us convertía TODA la app con un número un 71 %
 * por encima de cualquier cifra realmente pagada.
 *
 * Lo que se fija acá es que el modo mande sobre la serie, y que cambiarlo no
 * apague la recolección: la serie se sigue guardando para el día que la clínica
 * pase a operar al oficial.
 */

interface Opciones {
  modo?: ModoTipoCambio;
  valorFijo?: number;
  /** `null` = la tabla del TC diario está vacía. */
  oficial?: number | null;
  /** `false` = todavía no existe la fila de configuración. */
  hayConfiguracion?: boolean;
}

function montar(opciones: Opciones = {}) {
  const escrituras: Array<Record<string, unknown>> = [];
  const auditorias: Array<{ accion: string; datos: unknown }> = [];
  const oficial = opciones.oficial === undefined ? 11.92 : opciones.oficial;

  const prisma = {
    configuracionTipoCambio: {
      findUnique: async () =>
        opciones.hayConfiguracion === false
          ? null
          : {
              id: 1,
              modo: opciones.modo ?? ModoTipoCambio.FIJO,
              valorFijo: opciones.valorFijo ?? 6.97,
              updatedAt: new Date('2026-08-29'),
            },
      upsert: async ({ update }: { update: Record<string, unknown> }) => {
        escrituras.push(update);
        return update;
      },
    },
    tipoCambioDiario: {
      findFirst: async () =>
        oficial === null ? null : { valor: oficial, fecha: new Date('2026-08-29'), fuente: 'AUTOMATICO' },
    },
  };

  const audit = {
    registrar: async (_e: string, _id: string, accion: string, _u: string, datos: unknown) => {
      auditorias.push({ accion, datos });
    },
  };

  return {
    servicio: new TipoCambioService(prisma as never, audit as never),
    escrituras,
    auditorias,
  };
}

describe('vigente · con el modo FIJO', () => {
  it('devuelve el valor pactado, no el oficial del día', async () => {
    const { servicio } = montar({ modo: ModoTipoCambio.FIJO, valorFijo: 6.97, oficial: 11.92 });

    const vigente = await servicio.vigente();

    expect(vigente.tipoCambio).toBe(6.97);
    expect(vigente.fuente).toBe('FIJO');
  });

  /* La pantalla necesita poder decir "esto está a 6,97 fijo" y no "este es el
     oficial de hoy": son afirmaciones distintas sobre el mismo número. */
  it('la fuente lo declara, no se disfraza de oficial', async () => {
    const { servicio } = montar({ modo: ModoTipoCambio.FIJO });

    expect((await servicio.vigente()).fuente).not.toBe('AUTOMATICO');
  });

  it('ignora el oficial aunque la serie esté al día', async () => {
    const { servicio } = montar({ modo: ModoTipoCambio.FIJO, valorFijo: 6.97, oficial: 20 });

    expect((await servicio.vigente()).tipoCambio).toBe(6.97);
  });
});

describe('vigente · con el modo AUTOMATICO', () => {
  it('vuelve a seguir la serie diaria del BCB', async () => {
    const { servicio } = montar({ modo: ModoTipoCambio.AUTOMATICO, oficial: 11.92 });

    const vigente = await servicio.vigente();

    expect(vigente.tipoCambio).toBe(11.92);
    expect(vigente.fuente).toBe('AUTOMATICO');
  });

  it('sin serie cargada cae al respaldo', async () => {
    const { servicio } = montar({ modo: ModoTipoCambio.AUTOMATICO, oficial: null });

    expect((await servicio.vigente()).fuente).toBe('RESPALDO');
  });
});

describe('configuracion', () => {
  /*
   * Base recién migrada: la lectura NO puede crear la fila. La atiende cada
   * carga de la app, y una lectura que escribe es una escritura disfrazada.
   */
  it('sin fila todavía, asume FIJO a 6,97 sin escribir nada', async () => {
    const { servicio, escrituras } = montar({ hayConfiguracion: false });

    const config = await servicio.configuracion();

    expect(config.modo).toBe(ModoTipoCambio.FIJO);
    expect(config.valorFijo).toBe(6.97);
    expect(escrituras).toHaveLength(0);
  });

  /* El oficial viaja SIEMPRE, se use o no: es lo que permite que la pantalla
     muestre "operas a 6,97; hoy el oficial es 11,92" y se vea la diferencia. */
  it('informa el oficial del día aunque esté en modo fijo', async () => {
    const { servicio } = montar({ modo: ModoTipoCambio.FIJO, oficial: 11.92 });

    expect((await servicio.configuracion()).oficialDelDia).toBe(11.92);
  });
});

describe('actualizarConfiguracion', () => {
  it('cambiar de modo queda en auditoría', async () => {
    const { servicio, auditorias } = montar({ modo: ModoTipoCambio.FIJO });

    await servicio.actualizarConfiguracion({ modo: ModoTipoCambio.AUTOMATICO }, 'u1');

    expect(auditorias[0]).toMatchObject({
      accion: 'ACTUALIZAR',
      datos: { modo: ModoTipoCambio.AUTOMATICO },
    });
  });

  /* Los dos campos son opcionales para poder subir el valor pactado sin salir
     del modo fijo, que es lo más habitual. Tocar uno no puede resetear el otro. */
  it('cambiar solo el valor conserva el modo', async () => {
    const { servicio, escrituras } = montar({ modo: ModoTipoCambio.FIJO, valorFijo: 6.97 });

    await servicio.actualizarConfiguracion({ valorFijo: 7.2 }, 'u1');

    expect(escrituras[0]).toMatchObject({ modo: ModoTipoCambio.FIJO, valorFijo: 7.2 });
  });

  it('cambiar solo el modo conserva el valor pactado', async () => {
    const { servicio, escrituras } = montar({ modo: ModoTipoCambio.AUTOMATICO, valorFijo: 6.97 });

    await servicio.actualizarConfiguracion({ modo: ModoTipoCambio.FIJO }, 'u1');

    expect(escrituras[0]).toMatchObject({ modo: ModoTipoCambio.FIJO, valorFijo: 6.97 });
  });
});
