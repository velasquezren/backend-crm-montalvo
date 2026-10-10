/**
 * La frontera con el modelo. Todo lo que el asistente necesita de él.
 *
 * Es un puerto a propósito: el bucle, que es donde viven las reglas, se prueba
 * con un doble y no sabe que existe Vertex. Cambiar de proveedor —o de modelo
 * dentro de Vertex— toca el adaptador y nada más.
 *
 * El adaptador de Vertex vive aparte y se cablea cuando haya credenciales;
 * `docs/asistente-vertex.md` tiene su forma exacta y la bandera
 * `automaticFunctionCalling` que hay que apagar.
 */

/** Un turno del historial, tal como lo ve el modelo. */
export type TurnoModelo =
  | { readonly rol: 'paciente'; readonly texto: string }
  | { readonly rol: 'asistente'; readonly texto: string }
  /** Lo que el modelo pidió. */
  | { readonly rol: 'herramienta-pedida'; readonly nombre: string; readonly argumentos: Record<string, unknown> }
  /** Lo que le devolvimos. `ok: false` también va: tiene que poder corregirse. */
  | { readonly rol: 'herramienta-resultado'; readonly nombre: string; readonly resultado: unknown };

/** Lo que el modelo contesta a un turno: o pide herramientas, o habla. */
export type RespuestaModelo =
  | { readonly tipo: 'herramientas'; readonly llamadas: readonly { nombre: string; argumentos: Record<string, unknown> }[] }
  | { readonly tipo: 'texto'; readonly texto: string };

export interface ModeloConversacional {
  /**
   * Un turno. Recibe el historial completo y las declaraciones de las
   * herramientas; devuelve o llamadas o texto.
   *
   * `herramientasPermitidas` acota qué puede pedir en ESTE turno (en Vertex,
   * `toolConfig.allowedFunctionNames`): así se le quita `reservar` de la mesa
   * mientras falten el nombre o el CI, en vez de confiar en que no la pida.
   */
  responder(entrada: {
    readonly sistema: string;
    readonly historial: readonly TurnoModelo[];
    readonly herramientasPermitidas: readonly string[];
  }): Promise<RespuestaModelo>;
}
