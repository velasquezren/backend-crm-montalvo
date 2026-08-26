import { ConflictException, NotFoundException } from '@nestjs/common';

import { ConfiguracionComisionesService } from './configuracion-comisiones.service';

/**
 * `ReglaClasificacion` tiene hoy dos filas reales con el mismo patrón
 * ("Colocación de T de Cobre o DIU"), la misma prioridad y clasificaciones
 * distintas — cuál gana lo decide el orden en que Postgres devuelve las
 * filas, no nada que se pueda razonar (ver `buscarRegla()` en
 * `clasificador.ts`). Elegir cuál de las dos borrar es una decisión de
 * negocio que no toca este archivo; lo que se fija acá es que no se pueda
 * crear una TERCERA regla en la misma ambigüedad.
 *
 * Son pruebas de la REGLA, no de Prisma: el cliente es un doble que devuelve
 * lo que se le pide.
 */

interface ReglaFalsa {
  id: string;
  patron: string;
  modulo: string | null;
  clasif: string;
  prioridad: number;
  activa: boolean;
}

function montar(reglas: ReglaFalsa[] = []) {
  const creadas: Array<Record<string, unknown>> = [];
  const actualizadas: Array<{ id: string; data: Record<string, unknown> }> = [];

  const prisma = {
    reglaClasificacion: {
      findMany: async ({ where }: { where: { activa?: boolean; prioridad?: number; id?: { not: string } } }) =>
        reglas.filter(
          r =>
            (where.activa === undefined || r.activa === where.activa) &&
            (where.prioridad === undefined || r.prioridad === where.prioridad) &&
            (!where.id?.not || r.id !== where.id.not),
        ),
      findUnique: async ({ where }: { where: { id: string } }) =>
        reglas.find(r => r.id === where.id) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        creadas.push(data);
        return { id: 'nueva', ...data };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        actualizadas.push({ id: where.id, data });
        const actual = reglas.find(r => r.id === where.id);
        return { ...actual, ...data };
      },
    },
  };

  const servicio = new ConfiguracionComisionesService(prisma as never);
  return { servicio, creadas, actualizadas };
}

const REGLA_DIU: ReglaFalsa = {
  id: 'r1',
  patron: 'Colocación de T de Cobre o DIU',
  modulo: 'CONSULTA',
  clasif: 'CONSULTA',
  prioridad: 50,
  activa: true,
};

describe('ConfiguracionComisionesService · colisión de ReglaClasificacion', () => {
  it('crear una regla con el mismo patrón, módulo y prioridad que otra activa: rechazada', async () => {
    const { servicio, creadas } = montar([REGLA_DIU]);

    await expect(
      servicio.crearRegla({
        patron: 'Colocación de T de Cobre o DIU',
        modulo: 'CONSULTA',
        clasif: 'ECOGRAFIA',
        prioridad: 50,
      } as never),
    ).rejects.toThrow(ConflictException);

    expect(creadas).toHaveLength(0);
  });

  /*
   * Caso real (2026-08-26): "Cultivo de secreción vaginal" ya tenía regla
   * activa clasificando LAB, pero unas filas de un periodo que había estado
   * CERRADO cuando se creó la regla se quedaron sin reclasificar. Volver a
   * "Clasificar como… Laboratorio" desde el panel de alertas creaba una
   * regla IDÉNTICA a la existente, y chocaba consigo misma sin ninguna
   * forma de reintentar — la única salida era cambiar patrón o prioridad,
   * que habría creado un diccionario con dos entradas para lo mismo.
   */
  it('crear una regla que clasifica IGUAL que la existente: no choca, devuelve la existente sin duplicar', async () => {
    const { servicio, creadas } = montar([REGLA_DIU]);

    const resultado = await servicio.crearRegla({
      patron: 'Colocación de T de Cobre o DIU',
      modulo: 'CONSULTA',
      clasif: 'CONSULTA', // mismo clasif que REGLA_DIU
      prioridad: 50,
    } as never);

    expect(resultado).toEqual(REGLA_DIU);
    expect(creadas).toHaveLength(0); // nunca se llega a crear el duplicado
  });

  /* Mismo caso, ignorando mayúsculas/acentos/espacios — la comparación usa la
     misma normalización que el motor de clasificación real. */
  it('detecta la colisión aunque el patrón nuevo venga con otra capitalización', async () => {
    const { servicio } = montar([REGLA_DIU]);

    await expect(
      servicio.crearRegla({
        patron: '  colocación   de t de cobre o diu  ',
        modulo: 'consulta',
        clasif: 'ECOGRAFIA',
        prioridad: 50,
      } as never),
    ).rejects.toThrow(ConflictException);
  });

  it('un patrón que CONTIENE al de otra regla activa, misma prioridad y módulo, también choca', async () => {
    const { servicio } = montar([REGLA_DIU]);

    await expect(
      servicio.crearRegla({
        patron: 'T de Cobre',
        modulo: 'CONSULTA',
        clasif: 'LAB',
        prioridad: 50,
      } as never),
    ).rejects.toThrow(ConflictException);
  });

  it('misma prioridad pero MÓDULO distinto: no choca (no pueden aplicar a la misma fila)', async () => {
    const { servicio, creadas } = montar([REGLA_DIU]);

    await servicio.crearRegla({
      patron: 'Colocación de T de Cobre o DIU',
      modulo: 'LABORATORIO',
      clasif: 'LAB',
      prioridad: 50,
    } as never);

    expect(creadas).toHaveLength(1);
  });

  it('mismo patrón y módulo pero PRIORIDAD distinta: no choca (buscarRegla ya sabe cuál probar primero)', async () => {
    const { servicio, creadas } = montar([REGLA_DIU]);

    await servicio.crearRegla({
      patron: 'Colocación de T de Cobre o DIU',
      modulo: 'CONSULTA',
      clasif: 'ECOGRAFIA',
      prioridad: 10,
    } as never);

    expect(creadas).toHaveLength(1);
  });

  it('una regla INACTIVA no bloquea ni es bloqueada: no compite por nada', async () => {
    const { servicio, creadas } = montar([{ ...REGLA_DIU, activa: false }]);

    await servicio.crearRegla({
      patron: 'Colocación de T de Cobre o DIU',
      modulo: 'CONSULTA',
      clasif: 'ECOGRAFIA',
      prioridad: 50,
    } as never);

    expect(creadas).toHaveLength(1);
  });

  it('crear la propia regla inactiva no choca contra nadie', async () => {
    const { servicio, creadas } = montar([REGLA_DIU]);

    await servicio.crearRegla({
      patron: 'Colocación de T de Cobre o DIU',
      modulo: 'CONSULTA',
      clasif: 'ECOGRAFIA',
      prioridad: 50,
      activa: false,
    } as never);

    expect(creadas).toHaveLength(1);
  });

  it('sin prioridad explícita se evalúa contra el default (100), no se salta el chequeo', async () => {
    const { servicio, creadas } = montar([{ ...REGLA_DIU, prioridad: 100 }]);

    await expect(
      servicio.crearRegla({
        patron: 'Colocación de T de Cobre o DIU',
        modulo: 'CONSULTA',
        clasif: 'ECOGRAFIA',
        // sin `prioridad`: el schema la sembraría en 100, igual que REGLA_DIU
      } as never),
    ).rejects.toThrow(ConflictException);

    expect(creadas).toHaveLength(0);
  });

  describe('actualizarRegla', () => {
    /* La excepción de crearRegla (mismo clasif → devolver la existente) NO
       aplica acá: editar r2 para que termine idéntica a r1 no es "reintentar
       una clasificación", es dejar el diccionario con dos filas iguales. */
    it('editar una regla para que termine clasificando IGUAL que otra activa: sigue rechazado', async () => {
      const otra: ReglaFalsa = { ...REGLA_DIU, id: 'r2', prioridad: 90, clasif: REGLA_DIU.clasif };
      const { servicio, actualizadas } = montar([REGLA_DIU, otra]);

      await expect(
        servicio.actualizarRegla('r2', { prioridad: 50 } as never),
      ).rejects.toThrow(ConflictException);

      expect(actualizadas).toHaveLength(0);
    });


    it('editar SOLO la prioridad para que choque con otra regla activa: rechazado', async () => {
      // mismo patrón/módulo que REGLA_DIU, prioridad distinta: hoy no chocan
      const otra: ReglaFalsa = { ...REGLA_DIU, id: 'r2', prioridad: 90 };
      const { servicio, actualizadas } = montar([REGLA_DIU, otra]);

      /* El PATCH no toca el patrón — el chequeo tiene que usar el patrón YA
         guardado de r2, no quedarse corto porque este payload no lo trae. */
      await expect(
        servicio.actualizarRegla('r2', { prioridad: 50 } as never),
      ).rejects.toThrow(ConflictException);

      expect(actualizadas).toHaveLength(0);
    });

    it('editar sin tocar prioridad ni patrón no dispara el chequeo contra sí misma', async () => {
      const { servicio, actualizadas } = montar([REGLA_DIU]);

      await servicio.actualizarRegla('r1', { notas: 'revisar el mes que viene' } as never);

      expect(actualizadas).toHaveLength(1);
    });

    it('una regla que no existe da 404', async () => {
      const { servicio } = montar([]);

      await expect(
        servicio.actualizarRegla('no-existe', { prioridad: 10 } as never),
      ).rejects.toThrow(NotFoundException);
    });

    it('desactivar la regla que colisionaba la saca de la ecuación', async () => {
      const otra: ReglaFalsa = { ...REGLA_DIU, id: 'r2', prioridad: 90 };
      const { servicio, actualizadas } = montar([REGLA_DIU, otra]);

      await servicio.actualizarRegla('r2', { prioridad: 50, activa: false } as never);

      expect(actualizadas).toHaveLength(1);
    });
  });
});
