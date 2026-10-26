import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';

import { TareaPeriodica } from './tarea-periodica.decorator';
import { Tarea, TrabajosService } from './trabajos.service';

function servicio(instancias: object[] = [], config: Record<string, string> = {}): TrabajosService {
  const descubrimiento = { getProviders: () => instancias.map(instance => ({ instance })) } as unknown as DiscoveryService;
  return new TrabajosService(new ConfigService(config), descubrimiento, new MetadataScanner(), new Reflector());
}

function tarea(ejecutar: () => Promise<unknown>, extra: Partial<Tarea> = {}): Tarea {
  return { nombre: 'prueba', descripcion: 'tarea de prueba', cron: '* * * * *', cadaMs: 1_000, ejecutar, ...extra };
}

@Injectable()
class ConBarrido {
  readonly llamadas: string[] = [];
  @TareaPeriodica({ nombre: 'barrido-a', descripcion: 'barrido A', cron: '*/5 * * * *', cadaMs: 300_000 })
  async barrer(): Promise<void> { this.llamadas.push('a'); }
  /* Sin decorador: no es una tarea aunque viva en el mismo service. */
  async otra(): Promise<void> { this.llamadas.push('otra'); }
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('TrabajosService sin pg-boss (temporizadores, el camino por defecto)', () => {
  it('descubre solo los métodos con @TareaPeriodica y los corre con su instancia', async () => {
    jest.useFakeTimers();
    const conBarrido = new ConBarrido();
    const trabajos = servicio([conBarrido, { sinDecorador: true }]);
    const previo = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await trabajos.onApplicationBootstrap();
    } finally { process.env.NODE_ENV = previo; }

    await jest.advanceTimersByTimeAsync(300_000);
    expect(conBarrido.llamadas).toEqual(['a']);
    await trabajos.detener();
  });

  it('en las pruebas (NODE_ENV=test) no arranca nada solo', async () => {
    const conBarrido = new ConBarrido();
    jest.useFakeTimers();
    const trabajos = servicio([conBarrido]);
    await trabajos.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(600_000);
    expect(conBarrido.llamadas).toEqual([]);
  });

  it('una vuelta lenta no apila otra encima, como la cola stately', async () => {
    jest.useFakeTimers();
    let liberar!: () => void;
    const ejecutar = jest.fn(() => new Promise<void>(resolver => { liberar = resolver; }));
    const trabajos = servicio();
    expect(await trabajos.arrancar([tarea(ejecutar)])).toBe('TEMPORIZADORES');

    await jest.advanceTimersByTimeAsync(3_000);
    expect(ejecutar).toHaveBeenCalledTimes(1);
    liberar();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(ejecutar).toHaveBeenCalledTimes(2);
    await trabajos.detener();
  });

  it('la primera pasada respeta su demora, y un fallo queda en el log sin cortar las siguientes', async () => {
    jest.useFakeTimers();
    const errores = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const ejecutar = jest.fn().mockRejectedValueOnce(new Error('base caída')).mockResolvedValue(undefined);
    const trabajos = servicio();
    await trabajos.arrancar([tarea(ejecutar, { cadaMs: 60_000, primeraEnMs: 5_000 })]);

    await jest.advanceTimersByTimeAsync(4_999);
    expect(ejecutar).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(ejecutar).toHaveBeenCalledTimes(1);
    expect(String(errores.mock.calls[0]?.[0])).toContain('tarea de prueba');
    await jest.advanceTimersByTimeAsync(60_000);
    expect(ejecutar).toHaveBeenCalledTimes(2);
    await trabajos.detener();
  });

  it('dos tareas con el mismo nombre son un error de programación, no una carrera', async () => {
    const previo = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(servicio([new ConBarrido(), new ConBarrido()]).onApplicationBootstrap()).rejects.toThrow('barrido-a');
    } finally { process.env.NODE_ENV = previo; }
  });

  it('con TRABAJOS_PGBOSS=on pero pg-boss sin base, vuelve a los temporizadores', async () => {
    const trabajos = servicio([], { TRABAJOS_PGBOSS: 'on' });
    const ejecutar = jest.fn().mockResolvedValue(undefined);
    /* Un puerto cerrado: pg-boss no puede arrancar y la tarea no puede quedarse sin correr. */
    const modo = await trabajos.arrancar([tarea(ejecutar)], 'postgresql://nadie:nada@127.0.0.1:1/ninguna');
    expect(modo).toBe('TEMPORIZADORES');
    await trabajos.detener();
  });
});
