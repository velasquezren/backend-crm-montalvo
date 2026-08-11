/**
 * Caché en memoria con TTL, tope de entradas y deduplicación de cargas.
 *
 * Por qué existe: había tres cachés escritas a mano en el backend —el `Map` de
 * `KpisService` y los dos campos sueltos de `ConversacionesService`—, cada una
 * con su propio TTL, su propia forma de comprobar el vencimiento y ninguna
 * forma de vaciarla desde fuera. La de KPIs además **nunca borraba nada**: las
 * entradas vencían de forma lógica (`expiresAt` en el pasado) pero seguían
 * ocupando memoria para siempre, y su clave incluía las fechas libres que
 * llegan por query param (`?desde=…&hasta=…`), así que cada rango que alguien
 * eligiera en el calendario dejaba basura permanente en un proceso que corre
 * semanas.
 *
 * Dos cosas que esta clase hace y las tres versiones a mano no hacían:
 *
 * 1. **Tope duro de entradas con desalojo LRU.** Sin tope, una clave derivada
 *    de entrada del usuario es una fuga esperando a que alguien juegue con el
 *    filtro de fechas.
 * 2. **Deduplicación de cargas en vuelo.** Con la caché fría, cinco agentes
 *    abriendo el dashboard a la vez lanzaban cinco veces las mismas ocho
 *    consultas agregadas. Ahora la primera carga y las otras cuatro esperan su
 *    promesa.
 *
 * NO es una caché distribuida: vive en el proceso. Con varias instancias del
 * backend cada una tendría la suya y podrían discrepar durante un TTL. Hoy
 * corre un solo proceso; si algún día se escala horizontalmente, esto se
 * sustituye por Redis y este archivo es el único sitio a tocar — que es
 * justamente el punto de haberlo unificado.
 */
export interface OpcionesCache {
  /** Vida de una entrada, en milisegundos. */
  ttlMs: number;
  /**
   * Tope de entradas simultáneas. Al superarlo se purgan primero las vencidas
   * y, si aún sobra, se desaloja la menos usada recientemente.
   *
   * Por defecto 100: suficiente para cualquier caché de este backend y lo
   * bastante bajo para que una clave derivada de la entrada del usuario no
   * pueda crecer sin control.
   */
  maxEntradas?: number;
}

interface Entrada<T> {
  valor: T;
  expiraEn: number;
}

export class CacheMemoria<T> {
  private readonly entradas = new Map<string, Entrada<T>>();
  /** Cargas en curso, para que N peticiones simultáneas disparen una sola. */
  private readonly enVuelo = new Map<string, Promise<T>>();
  private readonly ttlMs: number;
  private readonly maxEntradas: number;

  constructor(opciones: OpcionesCache) {
    this.ttlMs = opciones.ttlMs;
    this.maxEntradas = opciones.maxEntradas ?? 100;
  }

  /**
   * Devuelve el valor cacheado y vigente, o `undefined`.
   *
   * Un acierto reordena la entrada al final del `Map`: el orden de inserción
   * de un `Map` de JS es estable, así que mover el acierto al final convierte
   * "la primera clave" en "la menos usada recientemente" — que es lo que
   * desaloja `hacerSitio()`.
   *
   * Una entrada vencida se reporta como ausente pero **no se borra aquí**: es
   * lo que permite que `obtenerAunqueVencido()` siga encontrándola cuando la
   * recarga falla. Del borrado se encarga `hacerSitio()` cuando haga falta el
   * espacio.
   */
  obtener(clave: string): T | undefined {
    const entrada = this.entradas.get(clave);
    if (!entrada) return undefined;
    if (Date.now() >= entrada.expiraEn) return undefined;

    this.entradas.delete(clave);
    this.entradas.set(clave, entrada);
    return entrada.valor;
  }

  /**
   * Último valor conocido de una clave, **aunque haya vencido**.
   *
   * Para el caso "la fuente externa no respondió y prefiero mostrar lo viejo
   * antes que nada": ver `listarPlantillas()`, donde una lista vacía no se lee
   * como "no pude preguntarle a Meta" sino como "no tienes plantillas", que es
   * una afirmación distinta y falsa.
   */
  obtenerAunqueVencido(clave: string): T | undefined {
    return this.entradas.get(clave)?.valor;
  }

  guardar(clave: string, valor: T): void {
    this.entradas.delete(clave);
    this.hacerSitio();
    this.entradas.set(clave, { valor, expiraEn: Date.now() + this.ttlMs });
  }

  /**
   * Get-or-load: devuelve lo cacheado o ejecuta `cargar()` una sola vez aunque
   * lo pidan N peticiones a la vez.
   *
   * Si `cargar()` lanza, la promesa en vuelo se retira antes de propagar el
   * error: si no, un fallo transitorio quedaría memorizado y todas las
   * peticiones siguientes recibirían la misma excepción sin reintentar nunca.
   * Un error tampoco se cachea — solo los aciertos.
   */
  async resolver(clave: string, cargar: () => Promise<T>): Promise<T> {
    const cacheado = this.obtener(clave);
    if (cacheado !== undefined) return cacheado;

    const enCurso = this.enVuelo.get(clave);
    if (enCurso) return enCurso;

    const promesa = cargar()
      .then(valor => {
        this.guardar(clave, valor);
        return valor;
      })
      .finally(() => {
        this.enVuelo.delete(clave);
      });

    this.enVuelo.set(clave, promesa);
    return promesa;
  }

  /** Sin clave, vacía la caché entera. Con clave, solo esa entrada. */
  invalidar(clave?: string): void {
    if (clave === undefined) {
      this.entradas.clear();
      return;
    }
    this.entradas.delete(clave);
  }

  /** Entradas guardadas, vencidas incluidas. Para pruebas y diagnóstico. */
  get tamano(): number {
    return this.entradas.size;
  }

  /**
   * Deja hueco para una entrada más: primero tira lo vencido (barato y no
   * pierde nada útil) y solo si aún no cabe desaloja la más antigua.
   */
  private hacerSitio(): void {
    if (this.entradas.size < this.maxEntradas) return;

    const ahora = Date.now();
    for (const [clave, entrada] of this.entradas) {
      if (ahora >= entrada.expiraEn) this.entradas.delete(clave);
    }

    while (this.entradas.size >= this.maxEntradas) {
      const masAntigua = this.entradas.keys().next();
      if (masAntigua.done) break;
      this.entradas.delete(masAntigua.value);
    }
  }
}
