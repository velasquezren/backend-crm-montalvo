import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import PgBoss from 'pg-boss';

import { reportarError } from '../errores/rastreo-errores';
import { enSegundoPlano } from '../fiabilidad/en-segundo-plano';
import { OpcionesTarea, TAREA_PERIODICA } from './tarea-periodica.decorator';

/** Una tarea lista para programar: sus opciones y qué ejecutar. */
export interface Tarea extends OpcionesTarea {
  readonly ejecutar: () => Promise<unknown>;
}

export type ModoTrabajos = 'PG_BOSS' | 'TEMPORIZADORES' | 'APAGADO';

/** El schema lo crea la migración `pgboss_trabajos`; la app nunca hace DDL al arrancar. */
const SCHEMA = 'pgboss';
/** Los cron se leen en hora de la clínica, no en la del VPS (America/New_York). */
const ZONA = 'America/La_Paz';
/**
 * Dos conexiones propias: pg-boss consulta su cola cada pocos segundos y no
 * debe competir con las diez del CRM (`PrismaService`) ni con Resultados.
 */
const CONEXIONES = 2;
const LIMITE_POR_DEFECTO_S = 15 * 60;
const SONDEO_S = 5;

/**
 * Quién corre los barridos periódicos del CRM (`@TareaPeriodica`).
 *
 * Con `TRABAJOS_PGBOSS=on`, **pg-boss** sobre el mismo Postgres: cada tarea es
 * una cola `stately` —como mucho una ejecución esperando y una corriendo, así
 * una vuelta lenta no apila otras—, programada con cron a la hora de La Paz,
 * con reintentos y con su historial en `pgboss.job` (cuándo corrió, cuánto
 * tardó, con qué error falló). Antes cada barrido era un `setInterval` propio,
 * con su hora atada al arranque y sin rastro de si falló.
 *
 * Sin la bandera, o si pg-boss no arranca (schema sin migrar, base caída), cada
 * tarea vuelve a su `setInterval` de siempre: encender esto no puede dejar al
 * CRM sin recalcular categorías ni cerrar chats.
 *
 * Las colas durables con estado propio (reintentos de envío, media, comprobantes,
 * transcripción) siguen con su barrido: sus reglas de lease, backoff y
 * FALLIDO/INCIERTO están probadas contra Postgres y no ganan nada mudándose.
 */
@Injectable()
export class TrabajosService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(TrabajosService.name);
  private boss: PgBoss | null = null;
  private readonly temporizadores: NodeJS.Timeout[] = [];
  private readonly corriendo = new Set<string>();

  constructor(
    private readonly config: ConfigService,
    private readonly descubrimiento: DiscoveryService,
    private readonly escaner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    /* Las pruebas no corren barridos de fondo; mismo criterio que tenía cada service. */
    if (process.env.NODE_ENV === 'test') return;
    await this.arrancar(this.descubrir());
  }

  async onApplicationShutdown(): Promise<void> {
    await this.detener();
  }

  /** Programa las tareas. Separado del arranque de Nest para que las pruebas pasen las suyas. */
  async arrancar(tareas: readonly Tarea[], connectionString = process.env['DATABASE_URL']): Promise<ModoTrabajos> {
    if (!tareas.length) return 'APAGADO';
    if (this.config.get<string>('TRABAJOS_PGBOSS') === 'on') {
      try {
        await this.conPgBoss(tareas, connectionString);
        this.logger.log(`pg-boss: ${tareas.length} tareas programadas (${tareas.map(t => t.nombre).join(', ')})`);
        return 'PG_BOSS';
      } catch (error) {
        this.logger.error('pg-boss no arrancó: las tareas vuelven a sus temporizadores', error);
        await this.boss?.stop({ graceful: false }).catch(() => undefined);
        this.boss = null;
      }
    }
    this.conTemporizadores(tareas);
    return 'TEMPORIZADORES';
  }

  async detener(): Promise<void> {
    for (const t of this.temporizadores.splice(0)) clearTimeout(t);
    const boss = this.boss;
    this.boss = null;
    await boss?.stop({ graceful: true, timeout: 10_000 });
  }

  /** Los métodos con `@TareaPeriodica` de todos los providers ya instanciados. */
  private descubrir(): Tarea[] {
    const tareas: Tarea[] = [];
    for (const { instance } of this.descubrimiento.getProviders()) {
      if (!instance || typeof instance !== 'object') continue;
      const prototipo = Object.getPrototypeOf(instance) as object;
      for (const metodo of this.escaner.getAllMethodNames(prototipo)) {
        const funcion = (instance as Record<string, unknown>)[metodo];
        if (typeof funcion !== 'function') continue;
        const opciones = this.reflector.get<OpcionesTarea | undefined>(TAREA_PERIODICA, funcion);
        if (opciones) tareas.push({ ...opciones, ejecutar: () => Promise.resolve(funcion.call(instance)) });
      }
    }
    const repetido = tareas.find((t, i) => tareas.findIndex(o => o.nombre === t.nombre) !== i);
    if (repetido) throw new Error(`Dos tareas periódicas se llaman «${repetido.nombre}»`);
    return tareas;
  }

  private async conPgBoss(tareas: readonly Tarea[], connectionString: string | undefined): Promise<void> {
    const boss = new PgBoss({
      connectionString, schema: SCHEMA, max: CONEXIONES, application_name: 'crm-trabajos',
      migrate: false, supervise: true, schedule: true,
    });
    boss.on('error', error => this.logger.error('pg-boss', error));
    this.boss = boss;
    await boss.start();

    const nombres = new Set(tareas.map(t => t.nombre));
    /* Una tarea renombrada o retirada dejaría su cron mandando trabajos que nadie atiende. */
    for (const programada of await boss.getSchedules()) {
      if (!nombres.has(programada.name)) await boss.unschedule(programada.name, programada.key);
    }

    for (const tarea of tareas) {
      const cola = {
        retryLimit: 2, retryDelay: 60, retryBackoff: true,
        expireInSeconds: tarea.limiteSegundos ?? LIMITE_POR_DEFECTO_S,
      };
      await boss.createQueue(tarea.nombre, { policy: 'stately', ...cola });
      await boss.updateQueue(tarea.nombre, cola);
      await boss.schedule(tarea.nombre, tarea.cron, {}, { tz: ZONA });
      await boss.work(tarea.nombre, { pollingIntervalSeconds: SONDEO_S }, async () => {
        try {
          await tarea.ejecutar();
        } catch (error) {
          this.logger.error(`Falló la tarea periódica: ${tarea.descripcion}; pg-boss la reintenta`, error);
          reportarError(error, { origen: tarea.descripcion });
          throw error;
        }
      });
      if (tarea.primeraEnMs !== undefined) {
        await boss.send(tarea.nombre, {}, { startAfter: Math.ceil(tarea.primeraEnMs / 1000) });
      }
    }
  }

  private conTemporizadores(tareas: readonly Tarea[]): void {
    for (const tarea of tareas) {
      const correr = () => {
        /* Como la cola `stately`: si la vuelta anterior sigue, esta no se apila. */
        if (this.corriendo.has(tarea.nombre)) return;
        this.corriendo.add(tarea.nombre);
        void enSegundoPlano(tarea.descripcion, this.logger, tarea.ejecutar)
          .finally(() => this.corriendo.delete(tarea.nombre));
      };
      if (tarea.primeraEnMs !== undefined) this.temporizadores.push(setTimeout(correr, tarea.primeraEnMs).unref());
      this.temporizadores.push(setInterval(correr, tarea.cadaMs).unref());
    }
  }
}
