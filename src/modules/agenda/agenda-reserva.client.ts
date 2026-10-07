import { Injectable, Logger, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { crearPoolAgenda } from './agenda-mysql';

/** Nombre del candado de MySQL que serializa a los escritores del CRM. */
const CANDADO = 'crm_agenda_reserva';

/**
 * Escritura en la agenda con el usuario `crm_agenda_reserva`, que SOLO puede
 * insertar en `para_agendar` y actualizar su comprobante, NIT, razón social y
 * estado (más leer lo imprescindible para comprobar la hora). Apagado salvo
 * `AGENDA_VPS_RESERVAS=on`.
 *
 * Cada reserva va en una transacción con un candado de MySQL (`GET_LOCK`): dos
 * pacientes que confirman la misma hora a la vez no pueden quedarse las dos con
 * ella. ScriptCase no lo usa, así que contra ScriptCase la defensa es volver a
 * comprobar la hora y la PK de `para_age`.
 */
@Injectable()
export class AgendaReservaClient implements OnModuleDestroy {
  private readonly logger = new Logger(AgendaReservaClient.name);
  private pool?: Pool;

  constructor(private readonly config: ConfigService) {}

  habilitada(): boolean {
    return this.config.get<string>('AGENDA_VPS_RESERVAS') === 'on';
  }

  private conexion(): Pool {
    this.pool ??= crearPoolAgenda(this.config, {
      usuarioEsperado: 'crm_agenda_reserva',
      variableUsuario: 'AGENDA_RESERVA_USUARIO',
      variablePassword: 'AGENDA_RESERVA_PASSWORD',
      conexiones: 2,
    });
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
      const [[fila]] = await conexion.query<RowDataPacket[]>('SELECT GET_LOCK(?, 5) AS ok', [CANDADO]);
      if (Number(fila?.ok) !== 1) throw new Error('Candado de reserva ocupado');
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
      this.logger.warn(`Reserva en la agenda no completada: ${error instanceof Error ? error.message : 'error'}`);
      throw this.noDisponible();
    } finally {
      clearTimeout(reloj);
      if (conexion && !destruida) {
        if (candado) await conexion.query('DO RELEASE_LOCK(?)', [CANDADO]).catch(() => undefined);
        conexion.release();
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }

  noDisponible(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      codigo: 'RESERVA_NO_DISPONIBLE',
      message: 'No pudimos registrar la reserva. Volvé a intentarlo o escribinos por WhatsApp.',
    });
  }
}
