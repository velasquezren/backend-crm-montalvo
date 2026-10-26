import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import PgBoss from 'pg-boss';

import { PrismaService } from '../../prisma/prisma.service';

import { Tarea, TrabajosService } from './trabajos.service';

/**
 * pg-boss DE VERDAD contra `crm_test`, con su schema creado por la migración
 * `pgboss_trabajos` (no por la app). Lo que se fija lo decide Postgres: que la
 * tarea corre por la cola, que queda en el historial, que un fallo se registra
 * para reintentarse y que una programación huérfana se limpia.
 */
const URL_TEST = 'postgresql://crm_app:crm_dev_local@localhost:5433/crm_test?schema=public';
if (!URL_TEST.includes('/crm_test')) throw new Error('La suite de integración solo puede correr contra la base crm_test');

const prisma = new PrismaService(URL_TEST);

/* pg-boss sondea su cola cada pocos segundos: el tope por defecto de Jest (5 s) no alcanza. */
jest.setTimeout(30_000);

function encendido(): TrabajosService {
  const descubrimiento = { getProviders: () => [] } as unknown as DiscoveryService;
  return new TrabajosService(new ConfigService({ TRABAJOS_PGBOSS: 'on' }), descubrimiento, new MetadataScanner(), new Reflector());
}

async function esperar(condicion: () => Promise<boolean>, ms = 20_000): Promise<void> {
  const hasta = Date.now() + ms;
  while (Date.now() < hasta) {
    if (await condicion()) return;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('No se cumplió a tiempo');
}

async function estados(nombre: string): Promise<string[]> {
  const filas = await prisma.$queryRaw<Array<{ state: string }>>`SELECT state::text FROM pgboss.job WHERE name = ${nombre} ORDER BY created_on`;
  return filas.map(f => f.state);
}

let trabajos: TrabajosService;

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});
beforeEach(async () => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  await prisma.$executeRaw`DELETE FROM pgboss.schedule`;
  await prisma.$executeRaw`DELETE FROM pgboss.job`;
  trabajos = encendido();
});
afterEach(async () => {
  await trabajos.detener();
  jest.restoreAllMocks();
});

describe('TrabajosService con pg-boss (TRABAJOS_PGBOSS=on)', () => {
  it('corre la tarea por la cola y la deja en el historial', async () => {
    const ejecutar = jest.fn().mockResolvedValue(undefined);
    const tarea: Tarea = { nombre: 'prueba-historial', descripcion: 'prueba', cron: '0 3 * * *', cadaMs: 86_400_000, primeraEnMs: 0, ejecutar };

    expect(await trabajos.arrancar([tarea], URL_TEST)).toBe('PG_BOSS');
    await esperar(async () => (await estados('prueba-historial')).includes('completed'));
    expect(ejecutar).toHaveBeenCalledTimes(1);
  });

  it('programa el cron a la hora de La Paz y limpia el de una tarea retirada', async () => {
    const boss = new PgBoss({ connectionString: URL_TEST, schema: 'pgboss', migrate: false, supervise: false, schedule: false, max: 1 });
    await boss.start();
    await boss.createQueue('tarea-retirada');
    await boss.schedule('tarea-retirada', '0 1 * * *');
    await boss.stop({ graceful: false });

    const tarea: Tarea = { nombre: 'prueba-cron', descripcion: 'prueba', cron: '30 */6 * * *', cadaMs: 1, ejecutar: async () => undefined };
    await trabajos.arrancar([tarea], URL_TEST);

    const filas = await prisma.$queryRaw<Array<{ name: string; cron: string; timezone: string }>>`SELECT name, cron, timezone FROM pgboss.schedule ORDER BY name`;
    expect(filas).toEqual([{ name: 'prueba-cron', cron: '30 */6 * * *', timezone: 'America/La_Paz' }]);
  });

  it('un fallo queda registrado y la tarea pasa a reintento, sin tumbar nada', async () => {
    const ejecutar = jest.fn().mockRejectedValue(new Error('base caída'));
    const tarea: Tarea = { nombre: 'prueba-fallo', descripcion: 'prueba que falla', cron: '0 3 * * *', cadaMs: 86_400_000, primeraEnMs: 0, ejecutar };

    await trabajos.arrancar([tarea], URL_TEST);
    await esperar(async () => (await estados('prueba-fallo')).includes('retry'));
    const [fila] = await prisma.$queryRaw<Array<{ output: { message?: string } }>>`SELECT output FROM pgboss.job WHERE name = 'prueba-fallo'`;
    expect(fila?.output?.message).toBe('base caída');
  });
});
