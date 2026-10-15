import { conRespaldo } from './con-respaldo';

/* Un intento que responde (o falla) cuando la prueba lo decide. */
function intentos() {
  const lanzados: { senal: AbortSignal; esperaMs: number; responder: (v: string) => void; fallar: (e: Error) => void }[] = [];
  const intento = (senal: AbortSignal, esperaMs: number) =>
    new Promise<string>((responder, fallar) => { lanzados.push({ senal, esperaMs, responder, fallar }); });
  return { lanzados, intento };
}

describe('conRespaldo: la copia de una llamada lenta', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('si la primera responde a tiempo, no hay copia', async () => {
    const { lanzados, intento } = intentos();
    const r = conRespaldo(intento, { esperaMs: 30_000, respaldoTrasMs: 5_000 });
    lanzados[0].responder('primera');
    await expect(r).resolves.toBe('primera');
    jest.advanceTimersByTime(10_000);
    expect(lanzados).toHaveLength(1);
  });

  it('si tarda, lanza una copia con el tiempo que queda, usa la que llegue primero y cancela la otra', async () => {
    const { lanzados, intento } = intentos();
    const avisos: string[] = [];
    const r = conRespaldo(intento, { esperaMs: 30_000, respaldoTrasMs: 5_000, alLanzarRespaldo: () => avisos.push('copia') });
    jest.advanceTimersByTime(5_000);
    expect(lanzados).toHaveLength(2);
    expect(lanzados[1].esperaMs).toBe(25_000);
    expect(avisos).toEqual(['copia']);
    lanzados[1].responder('copia');
    await expect(r).resolves.toBe('copia');
    expect(lanzados[0].senal.aborted).toBe(true);
    expect(lanzados[1].senal.aborted).toBe(false);
  });

  it('la primera también puede ganar después de lanzada la copia', async () => {
    const { lanzados, intento } = intentos();
    const r = conRespaldo(intento, { esperaMs: 30_000, respaldoTrasMs: 5_000 });
    jest.advanceTimersByTime(5_000);
    lanzados[0].responder('primera');
    await expect(r).resolves.toBe('primera');
    expect(lanzados[1].senal.aborted).toBe(true);
  });

  it('un error sin nada más en curso se propaga en el acto, sin esperar ni repetir', async () => {
    const { lanzados, intento } = intentos();
    const r = conRespaldo(intento, { esperaMs: 30_000, respaldoTrasMs: 5_000 });
    lanzados[0].fallar(new Error('400 INVALID_ARGUMENT'));
    await expect(r).rejects.toThrow('400');
    jest.advanceTimersByTime(10_000);
    expect(lanzados).toHaveLength(1);
  });

  it('si una falla con la otra en curso, se espera a la otra; si fallan las dos, el error es el último', async () => {
    const { lanzados, intento } = intentos();
    const r = conRespaldo(intento, { esperaMs: 30_000, respaldoTrasMs: 5_000 });
    jest.advanceTimersByTime(5_000);
    lanzados[0].fallar(new Error('504 primera'));
    lanzados[1].fallar(new Error('504 copia'));
    await expect(r).rejects.toThrow('504 copia');

    const otra = intentos();
    const r2 = conRespaldo(otra.intento, { esperaMs: 30_000, respaldoTrasMs: 5_000 });
    jest.advanceTimersByTime(5_000);
    otra.lanzados[0].fallar(new Error('504'));
    otra.lanzados[1].responder('copia');
    await expect(r2).resolves.toBe('copia');
  });

  it('sin respaldo, o si no cabe en la espera, es una llamada normal', async () => {
    for (const respaldoTrasMs of [undefined, 30_000, 40_000]) {
      const { lanzados, intento } = intentos();
      const r = conRespaldo(intento, { esperaMs: 30_000, respaldoTrasMs });
      jest.advanceTimersByTime(29_000);
      expect(lanzados).toHaveLength(1);
      expect(lanzados[0].esperaMs).toBe(30_000);
      lanzados[0].responder('ok');
      await expect(r).resolves.toBe('ok');
    }
  });
});
