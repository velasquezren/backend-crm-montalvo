import { Injectable, Logger, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { connect, isIP } from 'node:net';
import { createPool, Pool, PoolConnection } from 'mysql2/promise';
import { consultarAgendaSql, RecursoAgendaSql } from './agenda.sql';

/** SELECT con usuario restringido, TLS verificado, pool acotado y transacción
 * de solo lectura. No usa sesiones de ScriptCase ni escribe tablas del legado. */
@Injectable()
export class AgendaVpsClient implements OnModuleDestroy {
  private readonly logger = new Logger(AgendaVpsClient.name);
  private pool?: Pool;
  private enCurso = 0;
  private ultimoAviso = 0;
  constructor(private readonly config: ConfigService) {}

  habilitada(): boolean { return this.config.get<string>('AGENDA_VPS_LECTURA') === 'on'; }

  private conexion(): Pool {
    if (this.pool) return this.pool;
    const host = this.config.get<string>('AGENDA_MYSQL_HOST') ?? '';
    const identidad = this.config.get<string>('AGENDA_MYSQL_TLS_IDENTIDAD') ?? '';
    const caArchivo = this.config.get<string>('AGENDA_MYSQL_CA_ARCHIVO') ?? '';
    const usuario = this.config.get<string>('AGENDA_MYSQL_USUARIO') ?? '';
    const password = this.config.get<string>('AGENDA_MYSQL_PASSWORD') ?? '';
    const port = Number(this.config.get<string>('AGENDA_MYSQL_PUERTO') ?? 3306);
    if (!isIP(host) || !identidad || !caArchivo || usuario !== 'crm_agenda_lectura'
      || password.length < 32 || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('Configuración de lectura incompleta');
    }
    this.pool = createPool({
      // El certificado auditado tiene CN sin SAN/IP. Se verifica su identidad
      // contra SU CA; el socket usa la IP configurada, nunca entrada del público.
      host: identidad, port, stream: () => connect({ host, port }),
      user: usuario, password, database: 'clinica',
      ssl: { ca: readFileSync(caArchivo), rejectUnauthorized: true, verifyIdentity: true },
      connectionLimit: 4, maxIdle: 2, idleTimeout: 30_000, waitForConnections: false,
      connectTimeout: 3_000, enableKeepAlive: true, multipleStatements: false,
      dateStrings: true, supportBigNumbers: true, bigNumberStrings: true,
      charset: 'utf8mb4', timezone: '-04:00',
    });
    return this.pool;
  }

  async leer(recurso: RecursoAgendaSql, parametros: URLSearchParams): Promise<unknown> {
    if (!this.habilitada() || this.enCurso >= 4) throw this.noDisponible();
    this.enCurso++;
    let conexion: PoolConnection | undefined;
    let reloj: ReturnType<typeof setTimeout> | undefined;
    let terminada = false;
    try {
      conexion = await this.conexion().getConnection();
      // Destruir cancela el trabajo remoto; no dejar consultas huérfanas detrás
      // de Promise.race ni devolver una transacción fallida al pool.
      reloj = setTimeout(() => { terminada = true; conexion?.destroy(); }, 5_000);
      await conexion.query("SET SESSION time_zone = '-04:00'");
      await conexion.query('SET SESSION MAX_EXECUTION_TIME = 2500');
      await conexion.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      const resultado = await consultarAgendaSql(conexion, recurso, parametros);
      await conexion.commit();
      return resultado;
    } catch {
      if (!terminada) conexion?.destroy();
      terminada = true;
      if (Date.now() - this.ultimoAviso > 30_000) {
        this.ultimoAviso = Date.now();
        this.logger.warn('Lectura de agenda no disponible');
      }
      throw this.noDisponible();
    } finally {
      if (reloj) clearTimeout(reloj);
      if (!terminada) conexion?.release();
      this.enCurso--;
    }
  }

  async onModuleDestroy(): Promise<void> { await this.pool?.end(); }

  noDisponible(): ServiceUnavailableException {
    return new ServiceUnavailableException({ codigo: 'AGENDA_NO_DISPONIBLE', message: 'No pudimos consultar la agenda. Podés continuar en la agenda de la clínica o contactar con recepción.' });
  }
}
