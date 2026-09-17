import { BadRequestException, NotFoundException } from '@nestjs/common';


import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientesService } from '../clientes/clientes.service';
import { ServiciosService } from '../servicios/servicios.service';
import { ActividadesService } from './actividades.service';

/**
 * A5.2 · «esta y las siguientes», contra PostgreSQL real.
 *
 * Todas las fechas se escriben como instantes y se comprueban como instantes.
 * Las horas de la clínica (UTC-4) van con su equivalente UTC al lado, para que
 * la prueba no dependa de la zona del proceso — se ejecuta en UTC y en La Paz.
 */

const URL_TEST = 'postgresql://crm_app:crm_dev_local@localhost:5433/crm_test?schema=public';

if (!URL_TEST.includes('/crm_test')) {
  throw new Error('La suite de integración solo puede correr contra la base crm_test');
}

const prisma = new PrismaService(URL_TEST);
let service: ActividadesService;
let agenteA: string;
let agenteB: string;
let clienteId: string;

/** 09:00 en La Paz = 13:00 UTC. 10:30 en La Paz = 14:30 UTC. */
const L05 = '2026-10-05T13:00:00.000Z'; // lunes 05/10 09:00
const L12 = '2026-10-12T13:00:00.000Z';
const L19 = '2026-10-19T13:00:00.000Z';
const L26 = '2026-10-26T13:00:00.000Z';

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => { await prisma.$disconnect(); });

beforeEach(async () => {
  await prisma.actividad.deleteMany();
  await prisma.cliente.deleteMany();
  await prisma.usuario.deleteMany();

  const servicios = new ServiciosService(prisma);
  const clientes = new ClientesService(prisma, new AuditService(prisma), servicios);
  service = new ActividadesService(
    prisma, clientes,
    { enviarAUsuario: jest.fn() } as never,
    { emitirRecordatorioActividad: jest.fn() } as never,
  );

  const a = await prisma.usuario.create({
    data: { nombre: 'Agente A', email: 'a@a52.test', passwordHash: 'x', rol: 'AGENTE' },
  });
  const b = await prisma.usuario.create({
    data: { nombre: 'Agente B', email: 'b@a52.test', passwordHash: 'x', rol: 'AGENTE' },
  });
  agenteA = a.id;
  agenteB = b.id;
  const c = await prisma.cliente.create({
    data: { nombre: 'Ana', telefono: '+59170000052', agenteId: a.id },
  });
  clienteId = c.id;
});

/** Siembra una serie con las fechas dadas; devuelve sus ids en ese orden. */
async function sembrarSerie(
  fechas: string[],
  opciones: { serieId?: string; agente?: string; estados?: string[] } = {},
): Promise<string[]> {
  const serieId = opciones.serieId ?? `serie-${Math.random().toString(36).slice(2)}`;
  const ids: string[] = [];
  for (const [i, fecha] of fechas.entries()) {
    const fila = await prisma.actividad.create({
      data: {
        tipo: 'TAREA', titulo: 'Seguimiento', fechaProgramada: new Date(fecha),
        clienteId, agenteId: opciones.agente ?? agenteA,
        serieId, frecuenciaSerie: 'SEMANAL',
        estado: (opciones.estados?.[i] ?? 'PENDIENTE') as 'PENDIENTE',
      },
    });
    ids.push(fila.id);
  }
  return ids;
}

async function fechasDe(): Promise<string[]> {
  const filas = await prisma.actividad.findMany({ orderBy: { fechaProgramada: 'asc' } });
  return filas.map(f => f.fechaProgramada.toISOString());
}

describe('A5.2 · cambiar la hora de esta y las siguientes', () => {
  it('cambia la hora desde la elegida y cada una conserva SU día', async () => {
    const [, segunda] = await sembrarSerie([L05, L12, L19, L26]);

    const { afectadas } = await service.cambiarHoraDeFuturas(segunda, '10:30', agenteA);

    expect(afectadas).toBe(3);
    expect(await fechasDe()).toEqual([
      L05,                          // la anterior no se toca
      '2026-10-12T14:30:00.000Z',   // 12/10 10:30
      '2026-10-19T14:30:00.000Z',   // 19/10 10:30
      '2026-10-26T14:30:00.000Z',   // 26/10 10:30
    ]);
  });

  it('una ocurrencia movida a otro día conserva ese día y solo cambia de hora', async () => {
    /* La tercera se movió a mano al martes 20/10 a las 16:00 (20:00 UTC). */
    const [, segunda] = await sembrarSerie([L05, L12, '2026-10-20T20:00:00.000Z', L26]);

    await service.cambiarHoraDeFuturas(segunda, '10:30', agenteA);

    expect(await fechasDe()).toEqual([
      L05,
      '2026-10-12T14:30:00.000Z',
      '2026-10-20T14:30:00.000Z',   // sigue en martes 20, ahora a las 10:30
      '2026-10-26T14:30:00.000Z',
    ]);
  });

  it('una movida hacia ATRÁS deja de ser futura y no entra', async () => {
    /* La tercera se adelantó al 10/10, antes que la elegida (12/10). */
    const [, segunda] = await sembrarSerie([L05, L12, '2026-10-10T13:00:00.000Z', L26]);

    const { afectadas } = await service.cambiarHoraDeFuturas(segunda, '10:30', agenteA);

    expect(afectadas).toBe(2);
    expect(await fechasDe()).toEqual([
      L05,
      '2026-10-10T13:00:00.000Z',   // intacta: ya no está en el futuro de la elegida
      '2026-10-12T14:30:00.000Z',
      '2026-10-26T14:30:00.000Z',
    ]);
  });

  it('no toca las COMPLETADAS ni las CANCELADAS', async () => {
    const [, segunda] = await sembrarSerie(
      [L05, L12, L19, L26],
      { estados: ['PENDIENTE', 'PENDIENTE', 'COMPLETADA', 'CANCELADA'] },
    );

    const { afectadas } = await service.cambiarHoraDeFuturas(segunda, '10:30', agenteA);

    expect(afectadas).toBe(1);
    expect(await fechasDe()).toEqual([L05, '2026-10-12T14:30:00.000Z', L19, L26]);
  });

  it('limpia el aviso SOLO de las que de verdad se reprogramaron', async () => {
    const avisada = new Date('2026-10-01T12:00:00.000Z');
    const ids = await sembrarSerie([L05, L12, L19]);
    await prisma.actividad.updateMany({ data: { notificadaEn: avisada } });

    await service.cambiarHoraDeFuturas(ids[1], '10:30', agenteA);

    const filas = await prisma.actividad.findMany({ orderBy: { fechaProgramada: 'asc' } });
    expect(filas[0].notificadaEn?.toISOString()).toBe(avisada.toISOString()); // la anterior
    expect(filas[1].notificadaEn).toBeNull();
    expect(filas[2].notificadaEn).toBeNull();
  });

  it('una que ya estaba a esa hora no se cuenta ni pierde su aviso', async () => {
    const avisada = new Date('2026-10-01T12:00:00.000Z');
    /* La tercera ya está a las 10:30. */
    const ids = await sembrarSerie([L12, L19, '2026-10-26T14:30:00.000Z']);
    await prisma.actividad.updateMany({ data: { notificadaEn: avisada } });

    const { afectadas } = await service.cambiarHoraDeFuturas(ids[0], '10:30', agenteA);

    expect(afectadas).toBe(2);
    const yaEstaba = await prisma.actividad.findUniqueOrThrow({ where: { id: ids[2] } });
    expect(yaEstaba.notificadaEn?.toISOString()).toBe(avisada.toISOString());
  });
});

describe('A5.2 · cancelar esta y las siguientes', () => {
  it('cancela la elegida y las posteriores pendientes', async () => {
    const [, segunda] = await sembrarSerie([L05, L12, L19, L26]);

    const { afectadas } = await service.cancelarFuturas(segunda, agenteA);

    expect(afectadas).toBe(3);
    const filas = await prisma.actividad.findMany({ orderBy: { fechaProgramada: 'asc' } });
    expect(filas.map(f => f.estado)).toEqual(['PENDIENTE', 'CANCELADA', 'CANCELADA', 'CANCELADA']);
  });

  it('no reescribe el historial ya ejecutado', async () => {
    const completada = new Date('2026-10-19T14:00:00.000Z');
    const [, segunda, tercera] = await sembrarSerie(
      [L05, L12, L19, L26],
      { estados: ['PENDIENTE', 'PENDIENTE', 'COMPLETADA', 'PENDIENTE'] },
    );
    await prisma.actividad.update({ where: { id: tercera }, data: { completadaEn: completada } });

    const { afectadas } = await service.cancelarFuturas(segunda, agenteA);

    expect(afectadas).toBe(2);
    const laCompletada = await prisma.actividad.findUniqueOrThrow({ where: { id: tercera } });
    expect(laCompletada.estado).toBe('COMPLETADA');
    expect(laCompletada.completadaEn?.toISOString()).toBe(completada.toISOString());
  });

  it('cancelar no toca el aviso: no hay hora nueva que anunciar', async () => {
    const avisada = new Date('2026-10-01T12:00:00.000Z');
    const [primera] = await sembrarSerie([L12, L19]);
    await prisma.actividad.updateMany({ data: { notificadaEn: avisada } });

    await service.cancelarFuturas(primera, agenteA);

    const filas = await prisma.actividad.findMany();
    expect(filas.every(f => f.notificadaEn?.toISOString() === avisada.toISOString())).toBe(true);
  });
});

describe('A5.2 · permisos F04', () => {
  it('una AGENTE solo mueve las suyas, y el conteo lo dice', async () => {
    const serieId = 'serie-repartida';
    const ids = await sembrarSerie([L12, L19], { serieId });
    await sembrarSerie([L26, '2026-11-02T13:00:00.000Z'], { serieId, agente: agenteB });

    const { afectadas } = await service.cambiarHoraDeFuturas(ids[0], '10:30', agenteA);

    /* Cuatro comparten `serieId`; solo dos son de A. Las de B no se tocan
       aunque estén en la misma serie: compartirla no es un permiso. */
    expect(afectadas).toBe(2);
    const deB = await prisma.actividad.findMany({ where: { agenteId: agenteB } });
    expect(deB.map(f => f.fechaProgramada.toISOString())).toEqual([L26, '2026-11-02T13:00:00.000Z']);
  });

  it('un ADMIN sí alcanza toda la serie', async () => {
    const serieId = 'serie-repartida';
    const ids = await sembrarSerie([L12], { serieId });
    await sembrarSerie([L19, L26], { serieId, agente: agenteB });

    // Sin `soloAgenteId`: es el alcance global que `alcanceAgente()` da a ADMIN+.
    const { afectadas } = await service.cambiarHoraDeFuturas(ids[0], '10:30', undefined);

    expect(afectadas).toBe(3);
  });

  it('no alcanza una ocurrencia ajena ni para empezar', async () => {
    const [ajena] = await sembrarSerie([L12, L19], { agente: agenteB });

    await expect(service.cambiarHoraDeFuturas(ajena, '10:30', agenteA)).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('A5.2 · qué no es una serie', () => {
  it('dos series distintas no se mezclan aunque todo lo demás coincida', async () => {
    const unaA = await sembrarSerie([L12, L19], { serieId: 'serie-1' });
    await sembrarSerie([L12, L19], { serieId: 'serie-2' });

    const { afectadas } = await service.cambiarHoraDeFuturas(unaA[0], '10:30', agenteA);

    expect(afectadas).toBe(2);
    const otra = await prisma.actividad.findMany({ where: { serieId: 'serie-2' } });
    expect(otra.every(f => f.fechaProgramada.toISOString().endsWith('13:00:00.000Z'))).toBe(true);
  });

  it('una actividad suelta se rechaza con un mensaje que dice qué hacer', async () => {
    const suelta = await prisma.actividad.create({
      data: {
        tipo: 'TAREA', titulo: 'Suelta', fechaProgramada: new Date(L12),
        clienteId, agenteId: agenteA,
      },
    });

    await expect(service.cambiarHoraDeFuturas(suelta.id, '10:30', agenteA)).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.cancelarFuturas(suelta.id, agenteA)).rejects.toThrow(BadRequestException);
  });

  it('no se opera sobre la serie desde una que ya no está pendiente', async () => {
    const ids = await sembrarSerie([L12, L19], { estados: ['COMPLETADA', 'PENDIENTE'] });

    await expect(service.cambiarHoraDeFuturas(ids[0], '10:30', agenteA)).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('A5.2 · compatibilidad', () => {
  it('los PATCH individuales siguen afectando a una sola', async () => {
    const ids = await sembrarSerie([L12, L19, L26]);

    await service.update(ids[0], { fechaProgramada: new Date('2026-10-12T20:00:00.000Z') } as never, agenteA);
    await service.actualizarEstado(ids[1], { estado: 'CANCELADA' } as never, agenteA);

    /* Por id, no por posición. `sembrarSerie` crea las tres en un bucle
       secuencial, así que sus `createdAt` empatan al milisegundo en cuanto la
       base responde rápido, y `orderBy: { createdAt: 'asc' }` deja de ser
       determinista: la suite fallaba de forma intermitente afirmando que la
       segunda fila no estaba CANCELADA cuando sí lo estaba —solo que "la
       segunda" era otra—.
       Es el mismo empate que el proyecto ya arregló en el cursor del
       historial de conversaciones desempatando por id. Aquí ni siquiera hace
       falta un orden: `sembrarSerie` devuelve los ids en el orden sembrado,
       y lo que se prueba es qué le pasó a CADA actividad, no cómo se listan. */
    const [movida, cancelada, intacta] = await Promise.all(
      ids.map(id => prisma.actividad.findUniqueOrThrow({ where: { id } })),
    );
    expect(movida.fechaProgramada.toISOString()).toBe('2026-10-12T20:00:00.000Z');
    expect(cancelada.estado).toBe('CANCELADA');
    expect(intacta.estado).toBe('PENDIENTE');
    expect(intacta.fechaProgramada.toISOString()).toBe(L26);
  });
});

describe('A5.2 · concurrencia: lo que otra agente ya cerró no se toca', () => {
  /**
   * `cancelarFuturas` es un solo `updateMany`, así que su condición de lectura
   * ES la de escritura: se prueba de punta a punta con el service.
   */
  it('cancelar futuras: B completa antes, y esa queda COMPLETADA', async () => {
    const completadaEn = new Date('2026-10-19T14:00:00.000Z');
    const [, segunda, tercera] = await sembrarSerie([L05, L12, L19, L26]);

    // B, en otra conexión, cierra una de las que A va a cancelar.
    const conexionB = new PrismaService(URL_TEST);
    await conexionB.$connect();
    await conexionB.actividad.update({
      where: { id: tercera },
      data: { estado: 'COMPLETADA', completadaEn },
    });
    await conexionB.$disconnect();

    const { afectadas } = await service.cancelarFuturas(segunda, agenteA);

    expect(afectadas).toBe(2);
    const laDeB = await prisma.actividad.findUniqueOrThrow({ where: { id: tercera } });
    expect(laDeB.estado).toBe('COMPLETADA');
    expect(laDeB.completadaEn?.toISOString()).toBe(completadaEn.toISOString());
  });

  /**
   * En el cambio de hora la lectura y la escritura son sentencias distintas
   * dentro de una transacción, así que la carrera de verdad ocurre ENTRE las
   * dos. No hay forma de intercalarla desde el service sin un doble que el
   * proyecto no admite, de modo que aquí se reproduce con dos conexiones y las
   * MISMAS sentencias que ejecuta `cambiarHoraDeFuturas`.
   *
   * Lo que demuestra es la garantía que sostiene esa implementación: repetir
   * `estado = 'PENDIENTE'` en el UPDATE hace que una fila completada entre
   * medias quede fuera. Sin esa condición, READ COMMITTED la actualizaría.
   */
  it('cambio de hora: una fila completada entre la lectura y la escritura queda fuera', async () => {
    const [primera, segunda] = await sembrarSerie([L12, L19]);

    const conexionA = new PrismaService(URL_TEST);
    const conexionB = new PrismaService(URL_TEST);
    await Promise.all([conexionA.$connect(), conexionB.$connect()]);

    const resultado = await conexionA.$transaction(async tx => {
      // 1) A lee las candidatas: las dos están pendientes.
      const candidatas = await tx.actividad.findMany({
        where: { serieId: { not: null }, estado: 'PENDIENTE' },
        select: { id: true },
        orderBy: { fechaProgramada: 'asc' },
      });
      expect(candidatas).toHaveLength(2);

      // 2) B completa la segunda y CONFIRMA, con la transacción de A abierta.
      await conexionB.actividad.update({
        where: { id: segunda },
        data: { estado: 'COMPLETADA', completadaEn: new Date() },
      });

      // 3) A escribe, repitiendo la condición. La de B ya no la cumple.
      let afectadas = 0;
      for (const candidata of candidatas) {
        const { count } = await tx.actividad.updateMany({
          where: { id: candidata.id, estado: 'PENDIENTE' },
          data: { fechaProgramada: new Date('2026-11-30T14:30:00.000Z'), notificadaEn: null },
        });
        afectadas += count;
      }
      return afectadas;
    });

    await Promise.all([conexionA.$disconnect(), conexionB.$disconnect()]);

    expect(resultado).toBe(1);
    const laDeB = await prisma.actividad.findUniqueOrThrow({ where: { id: segunda } });
    expect(laDeB.estado).toBe('COMPLETADA');
    expect(laDeB.fechaProgramada.toISOString()).toBe(L19);
    const laDeA = await prisma.actividad.findUniqueOrThrow({ where: { id: primera } });
    expect(laDeA.fechaProgramada.toISOString()).toBe('2026-11-30T14:30:00.000Z');
  });
});
