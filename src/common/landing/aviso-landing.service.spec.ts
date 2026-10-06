import { ConfigService } from '@nestjs/config';

import { AvisoLandingService } from './aviso-landing.service';

/**
 * El aviso a la landing: agrupa, nunca lanza y se apaga sin configuración.
 * `fetch` se sustituye: estas pruebas no salen a la red (ver test/aislamiento-pruebas.cjs).
 */
describe('AvisoLandingService', () => {
  const configurado = () =>
    new AvisoLandingService(
      new ConfigService({ LANDING_REVALIDAR_URL: 'https://landing.test/api/revalidar', LANDING_REVALIDAR_SECRETO: 'secreto' }),
    );
  let fetchSimulado: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    fetchSimulado = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
  });
  afterEach(() => {
    jest.useRealTimers();
    fetchSimulado.mockRestore();
  });

  it('sin URL o sin secreto no avisa nunca', async () => {
    const apagado = new AvisoLandingService(new ConfigService({ LANDING_REVALIDAR_URL: 'https://landing.test/api/revalidar' }));
    expect(apagado.habilitado).toBe(false);
    apagado.avisar('promociones');
    await jest.runAllTimersAsync();
    expect(fetchSimulado).not.toHaveBeenCalled();
  });

  it('un mismo gesto se avisa una vez, con todas sus etiquetas y el secreto', async () => {
    const aviso = configurado();
    aviso.avisar('promociones');
    aviso.avisar('directorio', 'promociones');
    expect(fetchSimulado).not.toHaveBeenCalled();
    await jest.runAllTimersAsync();
    expect(fetchSimulado).toHaveBeenCalledTimes(1);
    const [url, opciones] = fetchSimulado.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://landing.test/api/revalidar');
    expect(opciones.method).toBe('POST');
    expect((opciones.headers as Record<string, string>).authorization).toBe('Bearer secreto');
    expect(JSON.parse(opciones.body as string)).toEqual({ etiquetas: ['promociones', 'directorio'] });
  });

  it('pasada la espera, un cambio nuevo es otro aviso', async () => {
    const aviso = configurado();
    aviso.avisar('promociones');
    await jest.runAllTimersAsync();
    aviso.avisar('directorio');
    await jest.runAllTimersAsync();
    expect(fetchSimulado).toHaveBeenCalledTimes(2);
    expect(JSON.parse((fetchSimulado.mock.calls[1] as [string, RequestInit])[1].body as string)).toEqual({ etiquetas: ['directorio'] });
  });

  it('si la landing falla o no responde, no lanza: solo lo registra', async () => {
    const aviso = configurado();
    fetchSimulado.mockRejectedValueOnce(new Error('ECONNREFUSED')).mockResolvedValueOnce(new Response('', { status: 503 }));
    const registro = jest.spyOn((aviso as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn').mockImplementation(() => undefined);
    aviso.avisar('promociones');
    await jest.runAllTimersAsync();
    aviso.avisar('promociones');
    await jest.runAllTimersAsync();
    expect(registro).toHaveBeenCalledTimes(2);
    expect(registro.mock.calls[0][0]).toContain('ECONNREFUSED');
    expect(registro.mock.calls[1][0]).toContain('503');
  });

  it('al apagar el proceso, lo pendiente sale en el acto', async () => {
    const aviso = configurado();
    aviso.avisar('directorio');
    await aviso.onModuleDestroy();
    expect(fetchSimulado).toHaveBeenCalledTimes(1);
    await jest.runAllTimersAsync();
    expect(fetchSimulado).toHaveBeenCalledTimes(1);
  });
});
