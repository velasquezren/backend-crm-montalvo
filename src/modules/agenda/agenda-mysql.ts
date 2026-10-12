import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { connect, isIP } from 'node:net';
import { createPool, Pool } from 'mysql2/promise';

/**
 * Pool hacia el MySQL de la agenda (montalvo-vps), común al usuario de
 * lectura y al de reservas. TLS verificado contra la CA del propio MySQL: su
 * certificado tiene CN sin SAN/IP, así que se valida esa identidad y el
 * socket va a la IP configurada, nunca a algo que venga del público.
 */
/** Cuánto vive una conexión ociosa del pool de la agenda. */
export const IDLE_AGENDA_MS = 10 * 60_000;

/** Códigos con los que mysql2 avisa que la conexión que tenía ya no existe. */
const CONEXION_CAIDA = new Set(['PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'EPIPE', 'ER_CLIENT_INTERACTION_TIMEOUT', 'PROTOCOL_SEQUENCE_TIMEOUT']);

/**
 * ¿El fallo es que la conexión del pool estaba muerta (la cerró MySQL o la red),
 * y no la consulta? Entonces una LECTURA se puede repetir con otra conexión sin
 * efecto alguno. Una escritura, nunca: no se sabe si llegó a aplicarse.
 */
export function esConexionCaida(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const codigo = (error as { code?: unknown }).code;
  if (typeof codigo === 'string' && CONEXION_CAIDA.has(codigo)) return true;
  const mensaje = (error as { message?: unknown }).message;
  return typeof mensaje === 'string' && /closed state|connection lost/i.test(mensaje);
}

export function crearPoolAgenda(
  config: ConfigService,
  cuenta: { readonly usuarioEsperado: string; readonly variableUsuario: string; readonly variablePassword: string; readonly conexiones: number },
): Pool {
  const host = config.get<string>('AGENDA_MYSQL_HOST') ?? '';
  const identidad = config.get<string>('AGENDA_MYSQL_TLS_IDENTIDAD') ?? '';
  const caArchivo = config.get<string>('AGENDA_MYSQL_CA_ARCHIVO') ?? '';
  const usuario = config.get<string>(cuenta.variableUsuario) ?? '';
  const password = config.get<string>(cuenta.variablePassword) ?? '';
  const port = Number(config.get<string>('AGENDA_MYSQL_PUERTO') ?? 3306);
  if (!isIP(host) || !identidad || !caArchivo || usuario !== cuenta.usuarioEsperado
    || password.length < 32 || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Configuración de la agenda incompleta');
  }
  return createPool({
    host: identidad, port, stream: () => connect({ host, port }),
    user: usuario, password, database: 'clinica',
    ssl: { ca: readFileSync(caArchivo), rejectUnauthorized: true, verifyIdentity: true },
    /* Las conexiones ociosas viven 10 min (antes 30 s). Medido el 12/10/2026
       desde este servidor: abrir una nueva (TCP + TLS + autenticación) cuesta
       17–80 ms y una consulta con la conexión abierta 1–14 ms; con 30 s casi
       cada visita al Directorio o a la reserva pagaba la conexión entera, y ese
       era su p95 de ~200 ms. MySQL las tolera 8 h (`wait_timeout` 28800) y el
       keep-alive de TCP las mantiene; si aun así una muere, la lectura se
       reintenta una vez (`esConexionCaida`). */
    connectionLimit: cuenta.conexiones, maxIdle: Math.min(2, cuenta.conexiones), idleTimeout: IDLE_AGENDA_MS,
    waitForConnections: false, connectTimeout: 3_000, enableKeepAlive: true, multipleStatements: false,
    dateStrings: true, supportBigNumbers: true, bigNumberStrings: true,
    charset: 'utf8mb4', timezone: '-04:00',
  });
}
