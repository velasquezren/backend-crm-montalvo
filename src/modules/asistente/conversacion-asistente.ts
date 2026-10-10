/**
 * El bucle: lo que el asistente hace con lo que escribió una paciente.
 *
 * Aquí viven las reglas, y a propósito no sabe que existe Vertex: recibe un
 * `ModeloConversacional` y el catálogo. Por eso se prueba con un doble, sin
 * credenciales y sin red. Tampoco manda nada: devuelve un texto y unas acciones,
 * y quien llama (`AsistenteChatService`) decide si se proponen o se envían.
 *
 * ## Las reglas
 *
 * 1. **Tope de vueltas.** Un modelo puede pedir herramientas en bucle. Al
 *    llegar al tope no se inventa un cierre: lo ve una persona.
 * 2. **Solo se le declara lo que puede usar.** Una escritura sin permiso, o las
 *    herramientas de ventas en una línea que no vende, no se le declaran; y si
 *    las pide igual, el despachador las rechaza.
 * 3. **Un error de herramienta vuelve al modelo**, no al chat: «esa promoción ya
 *    no está» es lo que le permite ofrecer otra.
 * 4. **Lo que el modelo pidió vuelve intacto** (`crudo`): Gemini 3 firma su
 *    razonamiento y rechaza la vuelta siguiente sin esa firma.
 * 5. **Un fallo del modelo no rompe nada**: el turno termina «sin respuesta» y
 *    el chat sigue esperando a una persona, como si el asistente no existiera.
 */
import { Injectable, Logger } from '@nestjs/common';

import { AccionAsistente, ContextoAsistente, declaraciones, herramientasDisponibles, HerramientasAsistenteService, ResultadoHerramienta } from './herramientas';
import { LlamadaHerramienta, ModeloConversacional, TurnoModelo } from './modelo.port';

/** Cuántas veces se le deja pedir herramientas antes de pasar a una persona. */
export const TOPE_DE_VUELTAS = 5;
/** Una respuesta con más acciones que esto es un modelo descontrolado, no una venta. */
export const TOPE_DE_ACCIONES = 3;

export interface TrazaTurno {
  readonly vueltas: number;
  readonly herramientas: readonly { readonly nombre: string; readonly ok: boolean }[];
  readonly tokensEntrada: number;
  readonly tokensSalida: number;
}

export type SalidaAsistente =
  /** Terminó. `texto` puede faltar si solo derivó. */
  | { readonly tipo: 'terminado'; readonly texto: string | null; readonly acciones: readonly AccionAsistente[]; readonly traza: TrazaTurno }
  /** No hay respuesta usable. `motivo` es para el registro, no para la paciente. */
  | { readonly tipo: 'sin-respuesta'; readonly motivo: string; readonly acciones: readonly AccionAsistente[]; readonly traza: TrazaTurno };

export interface PeticionAsistente {
  readonly sistema: string;
  readonly contexto: ContextoAsistente;
  /** El historial de la conversación, ya recortado por quien llama. */
  readonly historial: readonly TurnoModelo[];
  /** Lo decide quien llama; el modelo no puede abrirlo. Hoy, siempre `false`. */
  readonly permitirEscritura: boolean;
}

@Injectable()
export class ConversacionAsistente {
  private readonly logger = new Logger(ConversacionAsistente.name);

  constructor(
    private readonly modelo: ModeloConversacional,
    private readonly herramientas: HerramientasAsistenteService,
  ) {}

  async responder(p: PeticionAsistente): Promise<SalidaAsistente> {
    const disponibles = herramientasDisponibles(p.contexto, { permitirEscritura: p.permitirEscritura });
    const declaradas = declaraciones(disponibles);
    const historial: TurnoModelo[] = [...p.historial];
    const acciones: AccionAsistente[] = [];
    const usadas: { nombre: string; ok: boolean }[] = [];
    let tokensEntrada = 0;
    let tokensSalida = 0;
    const traza = (vueltas: number): TrazaTurno => ({ vueltas, herramientas: usadas, tokensEntrada, tokensSalida });

    for (let vuelta = 1; vuelta <= TOPE_DE_VUELTAS; vuelta++) {
      let r;
      try {
        r = await this.modelo.responder({ sistema: p.sistema, historial, herramientas: declaradas });
      } catch (error: unknown) {
        return { tipo: 'sin-respuesta', motivo: `El modelo no respondió: ${mensajeDe(error)}`, acciones, traza: traza(vuelta) };
      }
      tokensEntrada += r.uso.tokensEntrada;
      tokensSalida += r.uso.tokensSalida;

      if (r.tipo === 'bloqueada') return { tipo: 'sin-respuesta', motivo: `El proveedor bloqueó la respuesta: ${r.motivo}`, acciones, traza: traza(vuelta) };

      if (r.tipo === 'texto') {
        const texto = r.texto.trim();
        /* Un texto vacío no es una respuesta; salvo que ya la haya pasado a una
           persona: entonces no hay nada más que decir. */
        if (!texto && !acciones.some(a => a.tipo === 'DERIVAR')) {
          return { tipo: 'sin-respuesta', motivo: 'El modelo contestó vacío.', acciones, traza: traza(vuelta) };
        }
        return { tipo: 'terminado', texto: texto || null, acciones, traza: traza(vuelta) };
      }

      if (r.llamadas.length === 0) return { tipo: 'sin-respuesta', motivo: 'El modelo no pidió nada ni contestó.', acciones, traza: traza(vuelta) };

      historial.push({ rol: 'modelo-pide', llamadas: r.llamadas, crudo: r.crudo });
      const resultados: (LlamadaHerramienta & { resultado: unknown })[] = [];
      for (const llamada of r.llamadas) {
        const resultado = await this.ejecutar(llamada, p, acciones);
        usadas.push({ nombre: llamada.nombre, ok: resultado.ok });
        if (resultado.ok && resultado.accion) agregarAccion(acciones, resultado.accion);
        /* Vuelve al modelo TAL CUAL, acierto o error, sin la acción interna. */
        resultados.push({ ...llamada, resultado: resultado.ok ? { ok: true, datos: resultado.datos } : resultado });
      }
      historial.push({ rol: 'resultados', resultados });
    }

    return { tipo: 'sin-respuesta', motivo: `No cerró en ${TOPE_DE_VUELTAS} vueltas.`, acciones, traza: traza(TOPE_DE_VUELTAS) };
  }

  /**
   * Una llamada, con su red. Un fallo de la herramienta NO rompe el turno: se
   * le cuenta al modelo para que lo diga o pase a una persona. El motivo real
   * va al log y no al modelo: un «MySQL no responde» no es para la paciente.
   */
  private async ejecutar(llamada: LlamadaHerramienta, p: PeticionAsistente, acciones: readonly AccionAsistente[]): Promise<ResultadoHerramienta> {
    if (acciones.length >= TOPE_DE_ACCIONES && esAccion(llamada.nombre)) {
      return { ok: false, motivo: 'Ya hay suficientes envíos en esta respuesta. Contesta con texto.' };
    }
    try {
      return await this.herramientas.ejecutar(llamada.nombre, llamada.argumentos, p.contexto, { permitirEscritura: p.permitirEscritura });
    } catch (error: unknown) {
      this.logger.warn(`La herramienta «${llamada.nombre}» falló: ${mensajeDe(error)}`);
      return { ok: false, motivo: 'Ese dato no se pudo consultar ahora. Dilo así y pasa la conversación a una persona.' };
    }
  }
}

const esAccion = (nombre: string) => nombre === 'enviar_promocion' || nombre === 'enviar_horario';

/** La misma tarjeta o el mismo horario dos veces en una respuesta es uno. Derivar, una vez. */
function agregarAccion(acciones: AccionAsistente[], nueva: AccionAsistente): void {
  const repetida = acciones.some(a =>
    a.tipo === nueva.tipo &&
    (a.tipo === 'DERIVAR'
      || (a.tipo === 'PROMOCION' && nueva.tipo === 'PROMOCION' && a.promocionId === nueva.promocionId)
      || (a.tipo === 'HORARIO' && nueva.tipo === 'HORARIO' && a.medicoId === nueva.medicoId)));
  if (!repetida) acciones.push(nueva);
}

function mensajeDe(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : 'desconocido';
}
