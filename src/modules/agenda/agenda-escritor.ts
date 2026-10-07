import { Logger, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { crearPoolAgenda } from './agenda-mysql';

/** Una cuenta MySQL que ESCRIBE en la agenda, su interruptor y su candado. */
export interface CuentaEscritura {
  readonly usuarioEsperado: string;
  readonly variableUsuario: string;
  readonly variablePassword: string;
  readonly bandera: string;
  readonly conexiones: number;
  /** Candado de MySQL (`GET_LOCK`) que serializa a los escritores del CRM de esta cuenta. */
  readonly candado: string;
  readonly codigoNoDisponible: string;
  readonly mensajeNoDisponible: string;
}

/**
 * Escritura en la agenda ScriptCase: cada trabajo va en UNA transacción, con el
 * candado de su cuenta tomado, y cualquier fallo la deshace entera. Hay una
 * cuenta por propósito (reservas de la landing, administración de médicos) con
 * permisos distintos; comparten este mecanismo, no las credenciales.
 *
 * Las subclases llevan constructor explícito: Nest inyecta por los tipos del
 * constructor de la clase decorada, y uno heredado queda sin `ConfigService`.
 */
export abstract class EscritorAgenda implements OnModuleDestroy {
  private readonly logger = new Logger(this.constructor.name);
  private pool?: Pool;

  protected abstract readonly cuenta: CuentaEscritura;

  constructor(protected readonly config: ConfigService) {}

  habilitada(): boolean {
    return this.config.get<string>(this.cuenta.bandera) === 'on';
  }

  private conexion(): Pool {
    this.pool ??= crearPoolAgenda(this.config, this.cuenta);
    return this.pool;
  }

  /** Ejecuta `trabajo` en una transacción con el candado tomado. Cualquier fallo deshace todo. */
  async enTransaccion<T>(trabajo: (conexion: PoolConnection) => Promise<T>): Promise<T> {
    if (!this.habilitada()) throw this.noDisponible();
    let conexion: PoolConnection | undefined;
    let destruida = false;
    let candado = false;
    const reloj = setTimeout(() => { destruida = true; conexion?.destroy(); }, 10_000);
    try {
      conexion = await this.conexion().getConnection();
      await conexion.query("SET SESSION time_zone = '-04:00'");
      const [[fila]] = await conexion.query<RowDataPacket[]>('SELECT GET_LOCK(?, 5) AS ok', [this.cuenta.candado]);
      if (Number(fila?.ok) !== 1) throw new Error('Candado ocupado');
      candado = true;
      await conexion.query('START TRANSACTION');
      try {
        const resultado = await trabajo(conexion);
        await conexion.commit();
        return resultado;
      } catch (error) {
        if (!destruida) await conexion.rollback().catch(() => undefined);
        throw error;
      }
    } catch (error) {
      this.logger.warn(`Escritura en la agenda no completada: ${error instanceof Error ? error.message : 'error'}`);
      throw this.noDisponible();
    } finally {
      clearTimeout(reloj);
      if (conexion && !destruida) {
        if (candado) await conexion.query('DO RELEASE_LOCK(?)', [this.cuenta.candado]).catch(() => undefined);
        conexion.release();
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }

  noDisponible(): ServiceUnavailableException {
    return new ServiceUnavailableException({ codigo: this.cuenta.codigoNoDisponible, message: this.cuenta.mensajeNoDisponible });
  }
}
