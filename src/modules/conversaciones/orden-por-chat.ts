/**
 * Los envíos a Meta de UN MISMO chat, uno detrás de otro.
 *
 * `enviarMensaje` responde sin esperar a Meta (el globo no aguarda 300-900 ms),
 * así que cuando la agente manda varias fotos seguidas (18/11/2026: elegir
 * varias imágenes a la vez) los despachos se solapaban: la segunda foto podía
 * llegar a Meta antes que la primera —la grande tarda más en firmarse y
 * descargarse— y la paciente las recibía desordenadas. Aquí cada chat tiene su
 * cola: el siguiente despacho empieza cuando terminó el anterior, haya salido
 * bien o mal. Chats distintos no se esperan entre sí.
 *
 * En memoria a propósito: el backend es un solo proceso, y lo que se pierde en
 * un reinicio son despachos que el barrido de reintentos ya recupera.
 */
const colas = new Map<string, Promise<void>>();

export function enOrdenPorChat(conversacionId: string, trabajo: () => Promise<unknown>): Promise<void> {
  const anterior = colas.get(conversacionId) ?? Promise.resolve();
  const resultado = anterior.then(() => trabajo());
  /* La cola no se corta por un fallo: el siguiente despacho sale igual. */
  const cola = resultado.then(() => undefined, () => undefined);
  colas.set(conversacionId, cola);
  /* Al terminar, si nadie se encoló detrás, la cola del chat desaparece: el mapa no crece. */
  void cola.then(() => { if (colas.get(conversacionId) === cola) colas.delete(conversacionId); }).catch(() => undefined);
  /* Pero quien encoló SÍ recibe su error: `enSegundoPlano` lo registra y lo reporta. */
  return resultado.then(() => undefined);
}

/** Para las pruebas: cuántos chats tienen despachos en curso. */
export function chatsConDespachosEnCurso(): number {
  return colas.size;
}
