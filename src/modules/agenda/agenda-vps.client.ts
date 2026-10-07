import { Injectable, Logger, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolConnection } from 'mysql2/promise';
import { crearPoolAgenda } from './agenda-mysql';
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
    this.pool ??= crearPoolAgenda(this.config, {
      usuarioEsperado: 'crm_agenda_lectura', variableUsuario: 'AGENDA_MYSQL_USUARIO', variablePassword: 'AGENDA_MYSQL_PASSWORD', conexiones: 4,
    });
    return this.pool;
  }

  leer(recurso: RecursoAgendaSql, parametros: URLSearchParams): Promise<unknown> {
    return this.ejecutar(conexion => consultarAgendaSql(conexion, recurso, parametros));
  }

  /** Una consulta dentro de una transacción de solo lectura, con tiempo máximo. */
  async ejecutar<T>(trabajo: (conexion: PoolConnection) => Promise<T>): Promise<T> {
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
      const resultado = await trabajo(conexion);
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
