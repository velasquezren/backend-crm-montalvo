import { Logger, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolConnection } from 'mysql2/promise';
import { CuposAgenda } from './agenda-cupos';
import { crearPoolAgenda } from './agenda-mysql';

/** Una cuenta MySQL de solo lectura sobre la agenda y el interruptor que la enciende. */
export interface CuentaLectura {
  readonly usuarioEsperado: string;
  readonly variableUsuario: string;
  readonly variablePassword: string;
  readonly bandera: string;
  readonly conexiones: number;
  readonly mensajeNoDisponible: string;
}

/**
 * Lectura de la agenda ScriptCase: SELECT con un usuario restringido, TLS
 * verificado, pool acotado, transacción de solo lectura y tiempo máximo. Hay
 * dos cuentas con permisos distintos —la pública de la landing y la interna
 * del CRM, que sí ve datos de pacientes— y comparten este mecanismo, no las
 * credenciales: un fallo en una ruta pública no puede leer lo que solo ve
 * una sesión del CRM.
 */
export abstract class LectorAgenda implements OnModuleDestroy {
  private readonly logger = new Logger(this.constructor.name);
  private pool?: Pool;
  private cupos?: CuposAgenda;
  private ultimoAviso = 0;

  protected abstract readonly cuenta: CuentaLectura;

  constructor(protected readonly config: ConfigService) {}

  habilitada(): boolean {
    return this.config.get<string>(this.cuenta.bandera) === 'on';
  }

  private conexion(): Pool {
    this.pool ??= crearPoolAgenda(this.config, this.cuenta);
    return this.pool;
  }

  /** Una consulta dentro de una transacción de solo lectura, con tiempo máximo. */
  async ejecutar<T>(trabajo: (conexion: PoolConnection) => Promise<T>): Promise<T> {
    if (!this.habilitada()) throw this.noDisponible();
    /* Fila corta: un pico (la pantalla Reservas y el bloque del chat a la vez)
       espera un instante por una conexión en vez de fallar. Llena o vencida, 503. */
    this.cupos ??= new CuposAgenda(this.cuenta.conexiones, 1_500, this.cuenta.conexiones * 3);
    const devolverCupo = await this.cupos.tomar();
    if (!devolverCupo) throw this.noDisponible();
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
      devolverCupo();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }

  noDisponible(): ServiceUnavailableException {
    return new ServiceUnavailableException({ codigo: 'AGENDA_NO_DISPONIBLE', message: this.cuenta.mensajeNoDisponible });
  }
}
