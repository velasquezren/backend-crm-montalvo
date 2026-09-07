import { Logger } from '@nestjs/common';

/**
 * Dispara trabajo que nadie va a esperar, sin que su fallo tumbe el proceso.
 *
 * Node aborta ante una promesa rechazada sin manejar. Dentro de una petición no
 * importa —el filtro global la convierte en un 500—, pero este backend dispara
 * trabajo con `void` a propósito en una docena de sitios: el envío a Meta que no
 * debe hacer esperar a la agente (300-900 ms de round-trip), el barrido de
 * recordatorios cada cinco minutos, la sincronización del tipo de cambio cada
 * seis horas, la media entrante que se baja mientras el webhook ya respondió
 * 200. En ninguno de esos hay nadie escuchando el rechazo.
 *
 * Lo que se pierde al usar esto es la posibilidad de reaccionar al fallo, y esa
 * pérdida es deliberada **solo mientras el trabajo sea prescindible**. Si el
 * trabajo importa, no basta con no tumbar el proceso: hace falta estado y
 * reintento, que es la segunda entrega de F06 y todavía no existe. Hasta
 * entonces, un mensaje que no salió queda en FALLIDO y una agente lo reintenta
 * a mano; que es malo, pero es visible, y un proceso reiniciándose en bucle no.
 *
 * Recibe una función y no una promesa ya construida por un motivo concreto: así
 * también atrapa lo que lance ANTES de que exista la promesa. `enSegundoPlano('x',
 * log, () => this.a(b))` cubre un `b` que reviente al evaluarse; con
 * `enSegundoPlano('x', log, this.a(b))` esa excepción sería sincrónica y saldría
 * disparada por el sitio de la llamada, que es justo el hilo que se quería
 * proteger.
 *
 * **Nunca dentro del método que hace el trabajo.** Va en el punto donde se
 * dispara. `TipoCambioService.sincronizarAutomatico` es el ejemplo: lo llama el
 * `setInterval` de arranque, pero TAMBIÉN un controller que devuelve su
 * resultado. Tragarse el fallo adentro convertiría el 500 legítimo de ese
 * endpoint en un 200 que miente.
 *
 * @param contexto Qué se estaba haciendo, en una línea legible en el journal a
 *   las dos de la mañana. Sale tal cual en el log.
 */
export function enSegundoPlano(
  contexto: string,
  logger: Logger,
  trabajo: () => Promise<unknown>,
): Promise<void> {
  /* La promesa se devuelve, aunque los llamadores la descarten, para que una
     prueba pueda esperarla; sin eso habría que sembrar los tests de esperas por
     tiempo, que es como se construye una suite intermitente. Siempre resuelve. */
  return (async () => {
    try {
      await trabajo();
    } catch (error) {
      logger.error(`Falló en segundo plano: ${contexto}`, error);
    }
  })();
}
