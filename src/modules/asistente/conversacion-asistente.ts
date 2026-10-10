/**
 * El bucle: lo que el asistente hace con un mensaje de una paciente.
 *
 * Aquí viven las reglas, y a propósito no sabe que existe Vertex: recibe un
 * `ModeloConversacional` y un `HerramientasAsistenteService`. Por eso se prueba
 * con un doble, sin credenciales y sin red.
 *
 * ## Las cinco reglas
 *
 * 1. **Tope de vueltas.** Un modelo puede pedir herramientas en bucle. Al
 *    llegar al tope se pasa a una persona en vez de seguir gastando.
 * 2. **`reservar` no está en la mesa hasta que haya nombre y CI.** No se
 *    confía en que no la pida: se le quita de `herramientasPermitidas`, que en
 *    Vertex es `allowedFunctionNames`.
 * 3. **Un error de herramienta vuelve al modelo**, no al chat. `HORA_NO_DISPONIBLE`
 *    es información para que ofrezca otra hora, no un fallo que cortar.
 * 4. **Si el modelo no termina, no se inventa un cierre.** Se pide una persona.
 * 5. **Nada de lo que devuelve el modelo se trata como un hecho.** Esta clase no
 *    valida la verdad de su texto —eso no se puede— pero sí garantiza que todo
 *    dato que el texto pueda citar vino de una herramienta.
 */
import { Injectable, Logger } from '@nestjs/common';

import { ContextoAsistente, declaracionesParaElModelo, HERRAMIENTAS, HerramientasAsistenteService } from './herramientas';
import { ModeloConversacional, TurnoModelo } from './modelo.port';

/** Cuántas veces se le deja pedir herramientas antes de pasar a una persona. */
export const TOPE_DE_VUELTAS = 5;

export type SalidaAsistente =
  /** Hay respuesta para la paciente. */
  | { readonly tipo: 'responder'; readonly texto: string; readonly vueltas: number }
  /** No hay respuesta: lo ve una persona. `motivo` es para el log, no para la paciente. */
  | { readonly tipo: 'pasar-a-persona'; readonly motivo: string; readonly vueltas: number };

export interface PeticionAsistente {
  readonly sistema: string;
  readonly contexto: ContextoAsistente;
  /** El historial de la conversación, ya recortado por quien llama. */
  readonly historial: readonly TurnoModelo[];
  /**
   * `true` solo cuando la fase lo permite Y la paciente ya dio nombre y CI.
   * Lo decide quien llama; el modelo no puede abrirlo.
   */
  readonly permitirReservar: boolean;
}

const SOLO_LECTURA = HERRAMIENTAS.filter(h => !h.escribe).map(h => h.nombre);
const TODAS = HERRAMIENTAS.map(h => h.nombre);

@Injectable()
export class ConversacionAsistente {
  private readonly logger = new Logger(ConversacionAsistente.name);

  constructor(
    private readonly modelo: ModeloConversacional,
    private readonly herramientas: HerramientasAsistenteService,
  ) {}

  async responder(p: PeticionAsistente): Promise<SalidaAsistente> {
    /* Las declaraciones se calculan una vez: son las mismas todo el turno. */
    void declaracionesParaElModelo();
    const permitidas = p.permitirReservar ? TODAS : SOLO_LECTURA;
    const historial: TurnoModelo[] = [...p.historial];

    for (let vuelta = 1; vuelta <= TOPE_DE_VUELTAS; vuelta++) {
      const r = await this.modelo.responder({ sistema: p.sistema, historial, herramientasPermitidas: permitidas });

      if (r.tipo === 'texto') {
        const texto = r.texto.trim();
        /* Un modelo que contesta vacío no es una respuesta: es un turno perdido. */
        if (!texto) return { tipo: 'pasar-a-persona', motivo: 'el modelo contestó vacío', vueltas: vuelta };
        return { tipo: 'responder', texto, vueltas: vuelta };
      }

      if (r.llamadas.length === 0) {
        return { tipo: 'pasar-a-persona', motivo: 'el modelo no pidió nada ni contestó', vueltas: vuelta };
      }

      for (const llamada of r.llamadas) {
        historial.push({ rol: 'herramienta-pedida', nombre: llamada.nombre, argumentos: llamada.argumentos });
        const resultado = await this.ejecutar(llamada, p);
        /* El resultado vuelve al modelo TAL CUAL, acierto o error: un
           «esa hora ya no está» es lo que le permite ofrecer otra. */
        historial.push({ rol: 'herramienta-resultado', nombre: llamada.nombre, resultado });
      }
    }

    return { tipo: 'pasar-a-persona', motivo: `no cerró en ${TOPE_DE_VUELTAS} vueltas`, vueltas: TOPE_DE_VUELTAS };
  }

  /**
   * Una llamada, con su red. Un fallo de la herramienta NO rompe el turno: se
   * le cuenta al modelo para que lo diga o pruebe otra cosa. Lo que sí se
   * registra es el motivo, porque un error repetido aquí es un problema
   * nuestro, no suyo.
   */
  private async ejecutar(llamada: { nombre: string; argumentos: Record<string, unknown> }, p: PeticionAsistente): Promise<unknown> {
    try {
      return await this.herramientas.ejecutar(llamada.nombre, llamada.argumentos, p.contexto, {
        permitirEscritura: p.permitirReservar,
      });
    } catch (error: unknown) {
      this.logger.warn(`La herramienta «${llamada.nombre}» falló: ${error instanceof Error ? error.message : 'desconocido'}`);
      return { ok: false, motivo: 'Ese dato no se pudo consultar ahora. Dilo así y ofrece pasar con una persona.' };
    }
  }
}
