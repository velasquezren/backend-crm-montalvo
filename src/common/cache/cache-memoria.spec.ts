import { CacheMemoria } from './cache-memoria';

/**
 * Lo que se prueba aquí no es "que cachee" —eso es lo fácil y lo que las tres
 * versiones a mano ya hacían—, sino las dos cosas por las que existe esta
 * clase: que **borre** (la de KPIs no borraba nunca y era una fuga) y que no
 * dispare la misma carga N veces en paralelo.
 */

/** Espera un tick real: `resolver()` encadena promesas y hay que dejarlas correr. */
const tick = () => new Promise(resolve => setImmediate(resolve));

describe('CacheMemoria', () => {
  it('sirve el valor cacheado sin volver a llamar al cargador', async () => {
    const cache = new CacheMemoria<number>({ ttlMs: 1000 });
    const cargar = jest.fn().mockResolvedValue(42);

    expect(await cache.resolver('k', cargar)).toBe(42);
    expect(await cache.resolver('k', cargar)).toBe(42);
    expect(cargar).toHaveBeenCalledTimes(1);
  });

  it('vuelve a cargar cuando la entrada vence', async () => {
    jest.useFakeTimers();
    try {
      const cache = new CacheMemoria<number>({ ttlMs: 1000 });
      const cargar = jest.fn().mockResolvedValue(1);

      await cache.resolver('k', cargar);
      jest.advanceTimersByTime(1001);
      await cache.resolver('k', cargar);

      expect(cargar).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  /* El fallo original: `Map.set` sin tope y sin `delete`. La clave de KPIs
     lleva las fechas del query param, así que cada rango distinto que alguien
     eligiera quedaba en memoria hasta reiniciar el proceso. */
  it('nunca supera el tope de entradas aunque las claves sean infinitas', () => {
    const cache = new CacheMemoria<number>({ ttlMs: 60_000, maxEntradas: 10 });

    for (let i = 0; i < 5_000; i++) {
      cache.guardar(`rango-${i}`, i);
    }

    expect(cache.tamano).toBeLessThanOrEqual(10);
  });

  it('desaloja la menos usada recientemente, no la más vieja a secas', () => {
    const cache = new CacheMemoria<string>({ ttlMs: 60_000, maxEntradas: 3 });
    cache.guardar('a', 'A');
    cache.guardar('b', 'B');

    /* Se toca 'a': deja de ser la candidata a desalojo aunque entró primera. */
    expect(cache.obtener('a')).toBe('A');

    cache.guardar('c', 'C');
    cache.guardar('d', 'D'); // fuerza un desalojo

    expect(cache.obtener('a')).toBe('A');
    expect(cache.obtener('b')).toBeUndefined();
  });

  /* Con la caché fría, cinco agentes abriendo el dashboard a la vez lanzaban
     cinco veces las mismas ocho consultas agregadas contra Postgres. */
  it('dispara UNA sola carga aunque la pidan N peticiones simultáneas', async () => {
    const cache = new CacheMemoria<string>({ ttlMs: 1000 });
    let resolverCarga!: (valor: string) => void;
    const cargar = jest.fn(
      () => new Promise<string>(resolve => { resolverCarga = resolve; }),
    );

    const peticiones = [1, 2, 3, 4, 5].map(() => cache.resolver('kpis', cargar));
    await tick();
    resolverCarga('resultado');

    expect(await Promise.all(peticiones)).toEqual(Array(5).fill('resultado'));
    expect(cargar).toHaveBeenCalledTimes(1);
  });

  /* Si el fallo quedara memorizado como promesa en vuelo, un error transitorio
     de la base se convertiría en un error permanente hasta reiniciar. */
  it('no memoriza un fallo: la siguiente petición reintenta', async () => {
    const cache = new CacheMemoria<number>({ ttlMs: 1000 });
    const cargar = jest
      .fn()
      .mockRejectedValueOnce(new Error('la base no respondió'))
      .mockResolvedValueOnce(7);

    await expect(cache.resolver('k', cargar)).rejects.toThrow('la base no respondió');
    expect(await cache.resolver('k', cargar)).toBe(7);
    expect(cargar).toHaveBeenCalledTimes(2);
  });

  it('obtenerAunqueVencido devuelve lo viejo cuando la fuente externa falla', () => {
    jest.useFakeTimers();
    try {
      const cache = new CacheMemoria<string[]>({ ttlMs: 1000 });
      cache.guardar('plantillas', ['bienvenida']);

      jest.advanceTimersByTime(5000);

      expect(cache.obtener('plantillas')).toBeUndefined();
      expect(cache.obtenerAunqueVencido('plantillas')).toEqual(['bienvenida']);
    } finally {
      jest.useRealTimers();
    }
  });

  it('invalidar sin clave vacía la caché entera', () => {
    const cache = new CacheMemoria<number>({ ttlMs: 60_000 });
    cache.guardar('a', 1);
    cache.guardar('b', 2);

    cache.invalidar();

    expect(cache.tamano).toBe(0);
  });
});
