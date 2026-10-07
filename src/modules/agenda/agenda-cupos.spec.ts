import { CuposAgenda } from './agenda-cupos';

describe('CuposAgenda', () => {
  it('con cupos libres entrega al instante; sin cupos, el siguiente espera al que se libera', async () => {
    const cupos = new CuposAgenda(2, 1_000, 10);
    const a = (await cupos.tomar())!;
    const b = (await cupos.tomar())!;
    let tercero: (() => void) | null = null;
    const espera = cupos.tomar().then(c => (tercero = c));
    await Promise.resolve();
    expect(tercero).toBeNull();
    a();
    await espera;
    expect(tercero).not.toBeNull();
    b();
    tercero!();
  });

  it('si nadie libera a tiempo, o la fila está llena, falla rápido', async () => {
    jest.useFakeTimers();
    try {
      const cupos = new CuposAgenda(1, 500, 1);
      const unico = (await cupos.tomar())!;
      const enFila = cupos.tomar();
      expect(await cupos.tomar()).toBeNull(); // fila llena
      jest.advanceTimersByTime(501);
      expect(await enFila).toBeNull(); // venció la espera
      unico();
      unico(); // devolver dos veces no crea un cupo de más
      expect(await cupos.tomar()).not.toBeNull();
      const conTope = cupos.tomar();
      jest.advanceTimersByTime(501);
      expect(await conTope).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});
