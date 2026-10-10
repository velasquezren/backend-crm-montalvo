/**
 * La frontera con el proveedor de IA. Todo lo que el asistente necesita de él.
 *
 * Son clases abstractas y no interfaces porque Nest inyecta por el TOKEN, y una
 * interfaz no existe en tiempo de ejecución: `constructor(modelo: Interfaz)`
 * compila y recibe `undefined`. El módulo las cablea al adaptador de Vertex
 * (`vertex/proveedor-vertex.ts`); las pruebas, a un doble guionado.
 *
 * Cambiar de proveedor —o de modelo dentro de Vertex— toca el adaptador y nada
 * más: el bucle, las herramientas y las reglas no saben quién contesta.
 */

/** Una herramienta tal como se le declara al modelo (JSON Schema). */
export interface DeclaracionHerramienta {
  readonly name: string;
  readonly description: string;
  readonly parametersJsonSchema: unknown;
}

export interface LlamadaHerramienta {
  /** Lo pone el proveedor si lo usa; se devuelve con el resultado. */
  readonly id?: string;
  readonly nombre: string;
  readonly argumentos: Record<string, unknown>;
}

/** Un turno del historial, tal como lo ve el modelo. */
export type TurnoModelo =
  | { readonly rol: 'paciente'; readonly texto: string }
  /** Lo que salió de la clínica: una persona, un automático o el asistente. */
  | { readonly rol: 'clinica'; readonly texto: string }
  /**
   * Lo que el modelo pidió en una vuelta. `crudo` es SU contenido, intacto:
   * Gemini 3 firma su razonamiento (`thoughtSignature`) y rechaza con 400 la
   * vuelta siguiente si la firma no vuelve en la misma parte. Reconstruir la
   * llamada desde nombre y argumentos la pierde.
   */
  | { readonly rol: 'modelo-pide'; readonly llamadas: readonly LlamadaHerramienta[]; readonly crudo: unknown }
  /** Lo que le devolvimos. `ok: false` también va: tiene que poder corregirse. */
  | { readonly rol: 'resultados'; readonly resultados: readonly (LlamadaHerramienta & { readonly resultado: unknown })[] };

export interface UsoModelo {
  readonly tokensEntrada: number;
  readonly tokensSalida: number;
}

/** Lo que el modelo contesta a una vuelta: o pide herramientas, o habla, o se niega. */
export type RespuestaModelo =
  | { readonly tipo: 'herramientas'; readonly llamadas: readonly LlamadaHerramienta[]; readonly crudo: unknown; readonly uso: UsoModelo }
  | { readonly tipo: 'texto'; readonly texto: string; readonly uso: UsoModelo }
  /** El proveedor cortó la respuesta (seguridad, recitación…). No hay texto que publicar. */
  | { readonly tipo: 'bloqueada'; readonly motivo: string; readonly uso: UsoModelo };

export abstract class ModeloConversacional {
  /** El nombre del modelo, para el registro de turnos. */
  abstract readonly nombre: string;

  /**
   * Una vuelta. `herramientas` son SOLO las permitidas en esta vuelta: lo que no
   * se le declara, no lo puede pedir. (Vertex tiene `allowedFunctionNames`,
   * pero solo vale en modo `ANY`, que obliga a llamar siempre a una función.)
   */
  abstract responder(entrada: {
    readonly sistema: string;
    readonly historial: readonly TurnoModelo[];
    readonly herramientas: readonly DeclaracionHerramienta[];
  }): Promise<RespuestaModelo>;
}

/* ── El filtro de entrada ───────────────────────────────────────────── */

/**
 * De qué trata el mensaje. Lo decide un modelo pequeño ANTES de que el grande
 * conteste; la decisión de qué hacer con eso es código (`decidirTriaje`).
 */
export const CATEGORIAS = ['VENTAS', 'INFORMACION', 'SALUDO', 'MEDICO', 'URGENCIA', 'QUEJA', 'PERSONA', 'OTRO'] as const;
export type Categoria = (typeof CATEGORIAS)[number];

export const CONFIANZAS = ['ALTA', 'MEDIA', 'BAJA'] as const;
export type Confianza = (typeof CONFIANZAS)[number];

export interface Clasificacion {
  readonly categoria: Categoria;
  readonly confianza: Confianza;
  readonly uso: UsoModelo;
}

export abstract class ClasificadorMensajes {
  abstract readonly nombre: string;
  /**
   * `contexto` son los últimos mensajes (lo que ella escribió hace un momento
   * cambia el sentido de «¿y eso duele?»). `criterio` es el de la clínica.
   */
  abstract clasificar(entrada: { readonly mensaje: string; readonly contexto: readonly TurnoModelo[]; readonly criterio: string }): Promise<Clasificacion>;
}

/* ── La lectura de comprobantes ─────────────────────────────────────── */

/** Lo que el modelo leyó en la imagen. `null` = no aparece o no se lee. */
export interface DatosComprobante {
  readonly esComprobante: boolean;
  readonly monto: number | null;
  readonly moneda: string | null;
  /** «2026-10-10T14:32» en hora de Bolivia, si la imagen la trae. */
  readonly fechaHora: string | null;
  readonly referencia: string | null;
  readonly banco: string | null;
  /** A nombre de quién se pagó (el titular del QR). */
  readonly destinatario: string | null;
  /** Quién pagó. */
  readonly ordenante: string | null;
}

export abstract class LectorComprobantes {
  abstract readonly nombre: string;
  abstract leer(archivo: { readonly bytes: Uint8Array; readonly mime: string }): Promise<{ datos: DatosComprobante; uso: UsoModelo }>;
}
