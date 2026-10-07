import { Logger, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { CuposAgenda } from './agenda-cupos';
import { crearPoolAgenda } from './agenda-mysql';

/** Una cuenta MySQL que ESCRIBE en la agenda, su interruptor y su candado. */
export interface CuentaEscritura {
  readonly usuarioEsperado: string;
  readonly variableUsuario: string;
  readonly variablePassword: string;
  readonly bandera: string;
  /** Conexiones simultáneas: no más que el `MAX_USER_CONNECTIONS` de la cuenta. */
  readonly conexiones: number;
  /** Candado de MySQL (`GET_LOCK`) que serializa a los escritores del CRM de esta cuenta. */
  readonly candado: string;
  readonly codigoNoDisponible: string;
  readonly mensajeNoDisponible: string;
}

/** Lo que se espera una conexión libre antes de rendirse, y cuántos pedidos esperan a la vez. */
const ESPERA_CUPO_MS = 3_000;
const FILA_POR_CONEXION = 5;
/** Una transacción que no terminó en esto se corta: no deja la conexión ni el candado tomados. */
const TOPE_TRANSACCION_MS = 10_000;
const TOPE_LECTURA_MS = 5_000;

/**
 * Escritura en la agenda ScriptCase: cada trabajo va en UNA transacción, con el
 * candado de su cuenta tomado, y cualquier fallo la deshace entera. Hay una
 * cuenta por propósito (reservas de la landing, administración de médicos) con
 * permisos distintos; comparten este mecanismo, no las credenciales.
 *
 * Las LECTURAS de esa misma cuenta (`consultar`) no toman el candado: van en
 * una transacción de solo lectura con tiempo máximo, como `LectorAgenda`. Así
 * mirar la lista de médicos no espera detrás de quien guarda un horario.
 *
 * Lecturas y escrituras comparten los cupos de conexión, con fila de espera
 * corta (`CuposAgenda`): un pico de tres pedidos con dos conexiones espera,
 * no falla.
 *
 * Las subclases llevan constructor explícito: Nest inyecta por los tipos del
 * constructor de la clase decorada, y uno heredado queda sin `ConfigService`.
 */
export abstract class EscritorAgenda implements OnModuleDestroy {
  private readonly logger = new Logger(this.constructor.name);
  private pool?: Pool;
  private cupos?: CuposAgenda;

  protected abstract readonly cuenta: CuentaEscritura;

  constructor(protected readonly config: ConfigService) {}

  habilitada(): boolean {
    return this.config.get<string>(this.cuenta.bandera) === 'on';
  }

  private conexion(): Pool {
    this.pool ??= crearPoolAgenda(this.config, this.cuenta);
    return this.pool;
  }

  private cuposDeLaCuenta(): CuposAgenda {
    this.cupos ??= new CuposAgenda(this.cuenta.conexiones, ESPERA_CUPO_MS, this.cuenta.conexiones * FILA_POR_CONEXION);
    return this.cupos;
  }

  /**
   * Una conexión con cupo y tiempo máximo. Al vencer el tiempo se DESTRUYE
   * (MySQL cancela lo que estaba haciendo y suelta el candado de la sesión); si
   * no, se devuelve al pool. El cupo se devuelve siempre.
   */
  private async conConexion<T>(topeMs: number, trabajo: (conexion: PoolConnection) => Promise<T>): Promise<T> {
    if (!this.habilitada()) throw this.noDisponible();
    const devolverCupo = await this.cuposDeLaCuenta().tomar();
    if (!devolverCupo) throw this.noDisponible();
    let conexion: PoolConnection | undefined;
    let destruida = false;
    const reloj = setTimeout(() => {
      destruida = true;
      conexion?.destroy();
    }, topeMs);
    try {
      conexion = await this.conexion().getConnection();
      if (destruida) {
        conexion.destroy();
        throw new Error('Tiempo agotado antes de conectar');
      }
      await conexion.query("SET SESSION time_zone = '-04:00'");
      return await trabajo(conexion);
    } catch (error) {
      if (conexion && !destruida) {
        destruida = true;
        conexion.destroy();
      }
      throw error;
    } finally {
      clearTimeout(reloj);
      if (conexion && !destruida) conexion.release();
      devolverCupo();
    }
  }

  /** Ejecuta `trabajo` en una transacción con el candado tomado. Cualquier fallo deshace todo. */
  async enTransaccion<T>(trabajo: (conexion: PoolConnection) => Promise<T>): Promise<T> {
    try {
      return await this.conConexion(TOPE_TRANSACCION_MS, async conexion => {
        const [[fila]] = await conexion.query<RowDataPacket[]>('SELECT GET_LOCK(?, 5) AS ok', [this.cuenta.candado]);
        if (Number(fila?.ok) !== 1) throw new Error('Candado ocupado');
        try {
          await conexion.query('START TRANSACTION');
          const resultado = await trabajo(conexion);
          await conexion.commit();
          return resultado;
        } catch (error) {
          await conexion.rollback().catch(() => undefined);
          throw error;
        } finally {
          await conexion.query('DO RELEASE_LOCK(?)', [this.cuenta.candado]).catch(() => undefined);
        }
      });
    } catch (error) {
      this.logger.warn(`Escritura en la agenda no completada: ${error instanceof Error ? error.message : 'error'}`);
      throw this.noDisponible();
    }
  }

  /** Solo lectura, sin candado: una transacción READ ONLY con tiempo máximo por consulta. */
  async consultar<T>(trabajo: (conexion: PoolConnection) => Promise<T>): Promise<T> {
    try {
      return await this.conConexion(TOPE_LECTURA_MS, async conexion => {
        await conexion.query('SET SESSION MAX_EXECUTION_TIME = 2500');
        await conexion.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
        try {
          const resultado = await trabajo(conexion);
          await conexion.commit();
          return resultado;
        } finally {
          await conexion.query('SET SESSION MAX_EXECUTION_TIME = 0').catch(() => undefined);
        }
      });
    } catch (error) {
      this.logger.warn(`Lectura de la agenda no completada: ${error instanceof Error ? error.message : 'error'}`);
      throw this.noDisponible();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }

  noDisponible(): ServiceUnavailableException {
    return new ServiceUnavailableException({ codigo: this.cuenta.codigoNoDisponible, message: this.cuenta.mensajeNoDisponible });
  }
}
