import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { LatidoService } from './latido.service';

function latido(url: string | undefined, baseResponde: boolean) {
  const prisma = { $queryRaw: jest.fn(() => (baseResponde ? Promise.resolve([{ '?column?': 1 }]) : Promise.reject(new Error('base caída')))) };
  return new LatidoService(prisma as never, new ConfigService(url ? { LATIDO_URL: url } : {}));
}

describe('LatidoService', () => {
  let llamadas: string[];
  const fetchOriginal = global.fetch;
  beforeEach(() => {
    llamadas = [];
    global.fetch = jest.fn(async (url: string | URL | Request) => { llamadas.push(String(url)); return { ok: true } as Response; }) as typeof fetch;
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    global.fetch = fetchOriginal;
    jest.restoreAllMocks();
  });

  it('con la base respondiendo, avisa que sigue vivo', async () => {
    expect(await latido('https://hc-ping.com/abc/', true).latir()).toBe('VIVO');
    expect(llamadas).toEqual(['https://hc-ping.com/abc']);
  });

  it('con la base caída, avisa /fail para que el monitor alerte ya y no a los 5 minutos', async () => {
    expect(await latido('https://hc-ping.com/abc', false).latir()).toBe('FALLA');
    expect(llamadas).toEqual(['https://hc-ping.com/abc/fail']);
  });

  it('sin LATIDO_URL no llama a nadie; un monitor caído no lanza', async () => {
    expect(await latido(undefined, true).latir()).toBe('APAGADO');
    expect(llamadas).toEqual([]);
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as typeof fetch;
    await expect(latido('https://hc-ping.com/abc', true).latir()).resolves.toBe('VIVO');
  });
});
