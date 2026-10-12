import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolConnection } from 'mysql2/promise';

import { CuentaEscritura, EscritorAgenda } from './agenda-escritor';
import { CuentaLectura, LectorAgenda } from './agenda-lector';
import { esConexionCaida, IDLE_AGENDA_MS } from './agenda-mysql';

/*
 * Las conexiones ociosas de la agenda ahora viven 10 min (antes 30 s): si una
 * murió por el camino, una LECTURA se reintenta una vez con otra conexión, y una
 * ESCRITURA nunca. MySQL es externo: el pool es un doble.
 */

const caida = () => Object.assign(new Error('Connection lost: The server closed the connection.'), { code: 'PROTOCOL_CONNECTION_LOST' });

/** Una conexión falsa: `muerta` falla en su primera consulta como lo hace mysql2. */
function conexionFalsa(muerta: boolean) {
  return {
    query: jest.fn(async (sql: string) => {
      if (muerta) throw caida();
      if (/GET_LOCK/.test(sql)) return [[{ ok: 1 }]];
      return [[]];
    }),
    commit: jest.fn(async () => undefined),
    rollback: jest.fn(async () => undefined),
    release: jest.fn(),
    destroy: jest.fn(),
  };
}

function poolFalso(...conexiones: ReturnType<typeof conexionFalsa>[]) {
  return { getConnection: jest.fn(async () => conexiones.shift() as unknown as PoolConnection) };
}

const config = { get: () => 'on' } as unknown as ConfigService;

class LectorDePrueba extends LectorAgenda {
  protected readonly cuenta: CuentaLectura = {
    usuarioEsperado: 'x', variableUsuario: 'X', variablePassword: 'Y', bandera: 'B', conexiones: 2, mensajeNoDisponible: 'no',
  };
  constructor(private readonly pool: ReturnType<typeof poolFalso>) { super(config); }
  protected override conexion(): Pool { return this.pool as unknown as Pool; }
}

class EscritorDePrueba extends EscritorAgenda {
  protected readonly cuenta: CuentaEscritura = {
    usuarioEsperado: 'x', variableUsuario: 'X', variablePassword: 'Y', bandera: 'B', conexiones: 2,
    candado: 'c', codigoNoDisponible: 'NO', mensajeNoDisponible: 'no',
  };
  constructor(private readonly pool: ReturnType<typeof poolFalso>) { super(config); }
  protected override conexion(): Pool { return this.pool as unknown as Pool; }
}

describe('conexiones de la agenda que murieron en el pool', () => {
  it('reconoce una conexión caída, y no confunde con ella un error de la consulta', () => {
    expect(esConexionCaida(caida())).toBe(true);
    expect(esConexionCaida({ code: 'ECONNRESET' })).toBe(true);
    expect(esConexionCaida(new Error("Can't add new command when connection is in closed state"))).toBe(true);
    expect(esConexionCaida({ code: 'ER_PARSE_ERROR' })).toBe(false);
    expect(esConexionCaida({ code: 'ER_QUERY_TIMEOUT' })).toBe(false);
    expect(esConexionCaida(null)).toBe(false);
    expect(IDLE_AGENDA_MS).toBe(600_000);
  });

  it('una lectura con la conexión muerta se reintenta una vez con otra y responde', async () => {
    const muerta = conexionFalsa(true);
    const sana = conexionFalsa(false);
    const pool = poolFalso(muerta, sana);
    const r = await new LectorDePrueba(pool).ejecutar(async () => 'medicos');
    expect(r).toBe('medicos');
    expect(pool.getConnection).toHaveBeenCalledTimes(2);
    expect(muerta.destroy).toHaveBeenCalled();
    expect(sana.release).toHaveBeenCalled();
  });

  it('dos conexiones muertas seguidas: 503, sin un tercer intento', async () => {
    const pool = poolFalso(conexionFalsa(true), conexionFalsa(true), conexionFalsa(false));
    await expect(new LectorDePrueba(pool).ejecutar(async () => 'x')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(pool.getConnection).toHaveBeenCalledTimes(2);
  });

  it('un error de la propia consulta no se reintenta', async () => {
    const pool = poolFalso(conexionFalsa(false), conexionFalsa(false));
    const trabajo = jest.fn(async () => { throw Object.assign(new Error('sintaxis'), { code: 'ER_PARSE_ERROR' }); });
    await expect(new LectorDePrueba(pool).ejecutar(trabajo)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(trabajo).toHaveBeenCalledTimes(1);
    expect(pool.getConnection).toHaveBeenCalledTimes(1);
  });

  it('la lectura de una cuenta que escribe (el Directorio) también se reintenta una vez', async () => {
    const pool = poolFalso(conexionFalsa(true), conexionFalsa(false));
    await expect(new EscritorDePrueba(pool).consultar(async () => 'bancos')).resolves.toBe('bancos');
    expect(pool.getConnection).toHaveBeenCalledTimes(2);
  });

  it('una ESCRITURA con la conexión muerta no se repite: 503 y una sola conexión', async () => {
    const pool = poolFalso(conexionFalsa(true), conexionFalsa(false));
    const trabajo = jest.fn(async () => 'reserva');
    await expect(new EscritorDePrueba(pool).enTransaccion(trabajo)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(pool.getConnection).toHaveBeenCalledTimes(1);
    expect(trabajo).not.toHaveBeenCalled();
  });
});
