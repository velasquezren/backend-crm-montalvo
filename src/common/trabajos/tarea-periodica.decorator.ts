import { SetMetadata } from '@nestjs/common';

export const TAREA_PERIODICA = Symbol('tarea-periodica');

/** Cómo y cuándo corre un barrido periódico. Ver `TrabajosService`. */
export interface OpcionesTarea {
  /**
   * Nombre estable: es la cola en pg-boss (`pgboss.job.name`) y lo que sale en el
   * log. Cambiarlo deja huérfana la programación vieja (se limpia al arrancar).
   */
  readonly nombre: string;
  /** Una línea legible para el log si falla («recálculo de categorías…»). */
  readonly descripcion: string;
  /** Cuándo, en hora de La Paz: cron de cinco campos (`'30 *\/6 * * *'`). */
  readonly cron: string;
  /** Sin pg-boss, cada cuánto con `setInterval`: el comportamiento de siempre. */
  readonly cadaMs: number;
  /** Primera pasada tras arrancar, como hacían los barridos (ms). Sin esto, solo a su hora. */
  readonly primeraEnMs?: number;
  /** Tope de una ejecución antes de darla por colgada y reintentarla (s). */
  readonly limiteSegundos?: number;
}

/**
 * Marca un método sin argumentos como barrido periódico. No hace falta inyectar
 * nada: `TrabajosService` lo descubre al arrancar la app, igual que `@Cron` de
 * `@nestjs/schedule`. Las pruebas que construyen el service a mano no lo ven.
 *
 * El método puede lanzar: con pg-boss, el fallo queda en la base y se reintenta;
 * con temporizadores, se registra en el log y espera a la vuelta siguiente.
 */
export const TareaPeriodica = (opciones: OpcionesTarea): MethodDecorator => SetMetadata(TAREA_PERIODICA, opciones);
