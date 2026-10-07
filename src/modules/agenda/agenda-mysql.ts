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
    connectionLimit: cuenta.conexiones, maxIdle: Math.min(2, cuenta.conexiones), idleTimeout: 30_000,
    waitForConnections: false, connectTimeout: 3_000, enableKeepAlive: true, multipleStatements: false,
    dateStrings: true, supportBigNumbers: true, bigNumberStrings: true,
    charset: 'utf8mb4', timezone: '-04:00',
  });
}
