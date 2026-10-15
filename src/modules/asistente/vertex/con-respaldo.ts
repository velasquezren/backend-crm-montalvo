/**
 * Una llamada al modelo con copia de respaldo («hedged request»): si la primera
 * tarda más de lo normal, se lanza otra igual y se usa la que llegue primero; la
 * otra se cancela.
 *
 * Por qué: en Vertex (pago por uso, sin capacidad reservada) la mayoría de las
 * llamadas tarda poco pero unas pocas se quedan en cola. Medido en el proyecto
 * para `gemini-3.8-flash` (7 días al 14/10/2026): p50 1,8 s, p90 4,4 s, p99 47 s.
 * Esas esperas no dependen del pedido (la misma llamada tardó 1,7 s y luego
 * 12 s), así que una copia lanzada cerca del p90 casi siempre llega antes. Es la
 * técnica de «The Tail at Scale» (Dean y Barroso, 2013): recorta la cola larga
 * a cambio de duplicar solo las llamadas lentas.
 *
 * Es seguro porque `generateContent` no cambia nada: las herramientas las ejecuta
 * nuestro despachador después, con la respuesta que ganó. La copia va al MISMO
 * modelo: la firma del razonamiento de Gemini 3 (`crudo`) vale para ese modelo.
 */

export interface OpcionesRespaldo {
  /** Tiempo total del que dispone la llamada, contando la copia. */
  readonly esperaMs: number;
  /** Cuándo se lanza la copia. Sin valor (o si no cabe en `esperaMs`), no hay copia. */
  readonly respaldoTrasMs?: number;
  /** Para el registro: se lanzó la copia. */
  readonly alLanzarRespaldo?: () => void;
}

/**
 * `intento` recibe la señal para cancelarlo y el tiempo que le queda. La primera
 * respuesta gana. Si una falla mientras la otra sigue en curso, se espera a la
 * otra; si falla sin nada más en curso, se propaga en el acto (un 400 no mejora
 * repitiéndolo).
 */
export function conRespaldo<T>(
  intento: (senal: AbortSignal, esperaMs: number) => Promise<T>,
  { esperaMs, respaldoTrasMs, alLanzarRespaldo }: OpcionesRespaldo,
): Promise<T> {
  return new Promise<T>((resolver, rechazar) => {
    const controles: AbortController[] = [];
    let enCurso = 0;
    let terminado = false;
    let temporizador: ReturnType<typeof setTimeout> | undefined;

    const terminar = () => {
      terminado = true;
      clearTimeout(temporizador);
    };
    const lanzar = (espera: number) => {
      const control = new AbortController();
      controles.push(control);
      enCurso++;
      intento(control.signal, espera).then(
        valor => {
          if (terminado) return;
          terminar();
          for (const otro of controles) if (otro !== control) otro.abort();
          resolver(valor);
        },
        (error: unknown) => {
          enCurso--;
          if (terminado || enCurso > 0) return;
          terminar();
          rechazar(error);
        },
      );
    };

    lanzar(esperaMs);
    if (respaldoTrasMs !== undefined && respaldoTrasMs < esperaMs) {
      temporizador = setTimeout(() => {
        if (terminado) return;
        alLanzarRespaldo?.();
        lanzar(esperaMs - respaldoTrasMs);
      }, respaldoTrasMs);
    }
  });
}
