import { ServiceUnavailableException } from '@nestjs/common';

import { AgendaConsultaClient } from './agenda-consulta.client';
import { AgendaMedicoCitasService } from './agenda-medico-citas.service';
import { ESTADO_CITA_VIGENTE } from './agenda-medico-citas.sql';

/*
 * El servicio con una conexión falsa: lo que se fija es CÓMO se consulta (el
 * médico, el día y el estado vigente como parámetros, nunca pegados al SQL) y el
 * rango de fechas. Los resultados contra MySQL real están en la suite MySQL.
 */
function montar(filas: { agenda?: unknown[]; reservas?: unknown[] } = {}, habilitada = true, errorDetalle?: { errno: number }) {
  const execute = jest.fn(async (sql: string) => {
    if (errorDetalle && /a\.actividad/.test(sql)) throw Object.assign(new Error('sin permiso'), errorDetalle);
    return [/FROM agenda_med/.test(sql) ? filas.agenda ?? [] : filas.reservas ?? []];
  });
  const cliente = {
    habilitada: () => habilitada,
    ejecutar: jest.fn(async (trabajo: (db: unknown) => Promise<unknown>) => {
      if (!habilitada) throw new ServiceUnavailableException();
      return trabajo({ execute });
    }),
  };
  return { servicio: new AgendaMedicoCitasService(cliente as unknown as AgendaConsultaClient), execute, cliente };
}

/** Domingo 11/10/2026 22:00 en La Paz = lunes 12 a las 02:00 UTC. «Hoy» en la clínica es el 11, no el 12. */
const AHORA = new Date('2026-10-12T02:00:00Z');

describe('AgendaMedicoCitasService', () => {
  it('consulta con el médico, el día y el estado vigente como parámetros, no pegados al SQL', async () => {
    const { servicio, execute } = montar({
      agenda: [{ hora: '09:00', paciente: 'Ana Pérez' }],
      reservas: [{ hora: '10:00', nombre_age: 'Carla Soto', estado: 'PAGADO' }],
    });
    const a = await servicio.delDia(7, '2026-10-11', AHORA);
    expect(a.citas.map(c => [c.hora, c.paciente, c.estado])).toEqual([['09:00', 'Ana Pérez', 'CONFIRMADA'], ['10:00', 'Carla Soto', 'PAGO_POR_VERIFICAR']]);
    const [[sqlAgenda, paramsAgenda], [sqlReservas, paramsReservas]] = execute.mock.calls as unknown as [string, unknown[]][];
    expect(paramsAgenda).toEqual([7, '2026-10-11', ESTADO_CITA_VIGENTE, '300']);
    expect(paramsReservas).toEqual([7, '2026-10-11', 'PENDIENTE', 'PAGADO', '300']);
    /* Solo el nombre y la hora: nunca carnet, teléfono, PAC ni comprobante. */
    for (const sql of [sqlAgenda, sqlReservas]) expect(sql).not.toMatch(/ci_age|telefono|comprobante|\bpac\b|precio|nit/i);
    expect(sqlAgenda).toContain('a.estado = ?');
  });

  it('trae la actividad y el seguro de FileMaker; sin permiso para esas columnas, la agenda sale igual sin ellos', async () => {
    const fila = { hora: '09:00', paciente: 'Ana Pérez', actividad: 'Ecografía FIV', seguro: 'Particular' };
    const conDetalle = montar({ agenda: [fila] });
    expect((await conDetalle.servicio.delDia(7, '2026-10-11', AHORA)).citas[0]).toMatchObject({ actividad: 'Ecografía FIV', seguro: 'Particular' });
    expect(conDetalle.execute.mock.calls[0][0]).toContain('a.actividad, a.seguro');

    /* 1143 = ER_COLUMNACCESS_DENIED_ERROR: el despliegue llegó antes que el GRANT. */
    const sinPermiso = montar({ agenda: [{ hora: '09:00', paciente: 'Ana Pérez' }] }, true, { errno: 1143 });
    const a = await sinPermiso.servicio.delDia(7, '2026-10-11', AHORA);
    expect(a.citas).toEqual([{ hora: '09:00', paciente: 'Ana Pérez', estado: 'CONFIRMADA' }]);
    expect(sinPermiso.execute.mock.calls[1][0]).not.toContain('actividad');

    /* Cualquier otro error no se esconde: el asistente dice que no pudo consultar. */
    const caida = montar({}, true, { errno: 2013 });
    await expect(caida.servicio.delDia(7, '2026-10-11', AHORA)).rejects.toThrow('sin permiso');
  });

  it('«hoy» es el de La Paz: a las 22:00 del domingo todavía es domingo aunque en UTC sea lunes', async () => {
    const { servicio } = montar();
    await expect(servicio.delDia(7, '2026-10-11', AHORA)).resolves.toMatchObject({ fecha: '2026-10-11' });
    /* 31 días atrás desde el domingo 11 es el 10 de septiembre; el 9 ya no. */
    await expect(servicio.delDia(7, '2026-09-10', AHORA)).resolves.toBeDefined();
    await expect(servicio.delDia(7, '2026-09-09', AHORA)).rejects.toMatchObject({ status: 400 });
  });

  it('rechaza lo que no es una fecha que existe y lo que está fuera de rango, sin tocar la agenda', async () => {
    const { servicio, cliente } = montar();
    for (const mala of ['mañana', '2026-02-30', '12/10/2026', '2026-13-01', '']) {
      await expect(servicio.delDia(7, mala, AHORA)).rejects.toMatchObject({ status: 400 });
    }
    await expect(servicio.delDia(7, '2027-06-01', AHORA)).rejects.toMatchObject({ status: 400 });
    expect(cliente.ejecutar).not.toHaveBeenCalled();
  });

  it('si la lectura de la agenda está apagada, falla (503) y no inventa un día vacío', async () => {
    const { servicio } = montar({}, false);
    expect(servicio.disponible()).toBe(false);
    await expect(servicio.delDia(7, '2026-10-11', AHORA)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
