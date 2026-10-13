import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { R2Service } from '../../common/storage/r2.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TranscriptorAudio, UsoModelo } from '../asistente/modelo.port';
import { BYTES_MAXIMOS_AUDIO } from '../asistente/transcripcion';

/** Lo mínimo de un mensaje para saber si es una nota de voz de la ráfaga que se contesta. */
export interface MensajeEscuchable {
  readonly id: string;
  readonly direccion: 'ENTRANTE' | 'SALIENTE';
  readonly tipo: string;
  /** Un automático (acuse, menú) no corta lo que ella está diciendo; una persona, sí. */
  readonly automatico: boolean;
  /** La transcripción guardada, si ya se escuchó en un turno anterior. */
  readonly transcripcion: string | null;
}

/** Una ráfaga larga de audios es un monólogo: se escuchan los últimos, los demás quedan para una persona. */
export const AUDIOS_POR_TURNO = 3;
/** Cuánto se espera a que la nota de voz termine de bajar de Meta a R2 (`MediaEntranteService`). */
const ESPERA_AUDIO_POR_DEFECTO_MS = 20_000;
const PASO_ESPERA_MS = 1_000;

/**
 * Las notas de voz de la ráfaga que el asistente va a contestar: las de ella
 * desde el último mensaje de una PERSONA de la clínica (un acuse automático en
 * medio no corta lo que está diciendo), de la más vieja a la más nueva, con tope.
 * Lo de antes ya lo contestó alguien.
 */
export function audiosDeLaRafaga<T extends MensajeEscuchable>(mensajes: readonly T[]): T[] {
  const rafaga: T[] = [];
  for (let i = mensajes.length - 1; i >= 0; i--) {
    const m = mensajes[i];
    if (m.direccion === 'SALIENTE' && !m.automatico) break;
    if (m.direccion === 'ENTRANTE') rafaga.unshift(m);
  }
  return rafaga.filter(m => m.tipo === 'AUDIO').slice(-AUDIOS_POR_TURNO);
}

export interface Escucha {
  /**
   * Por id de mensaje: el texto —de un turno anterior o de este—, o `null` si en
   * este turno no se pudo escuchar (no llegó, muy grande, inaudible o el proveedor falló).
   * Una nota de voz anterior a la ráfaga que nunca se escuchó no está.
   */
  readonly transcripciones: ReadonlyMap<string, string | null>;
  readonly uso: UsoModelo;
}

/**
 * Escucha las notas de voz para el asistente (docs/asistente-ia.md, «Notas de
 * voz»). Lee el audio que `MediaEntranteService` ya dejó en R2, lo pasa a texto y
 * lo guarda en `Mensaje.transcripcion` (Conversaciones es el dueño de `Mensaje`):
 * cada audio va a Google UNA vez, y el asistente no pierde lo que ella dijo cuando
 * la conversación sigue. El texto entra al asistente como si ella lo hubiera
 * ESCRITO: mismo filtro de entrada, mismas herramientas, mismas reglas.
 *
 * Solo se llama desde un turno del asistente, que solo existe en una línea que la
 * clínica encendió: un audio de una línea sin asistente nunca sale del CRM.
 */
@Injectable()
export class EscuchaAudiosService {
  private readonly logger = new Logger(EscuchaAudiosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly r2: R2Service,
    private readonly transcriptor: TranscriptorAudio,
    private readonly config: ConfigService,
  ) {}

  async escuchar(mensajes: readonly MensajeEscuchable[]): Promise<Escucha> {
    const transcripciones = new Map<string, string | null>();
    for (const m of mensajes) if (m.tipo === 'AUDIO' && m.transcripcion) transcripciones.set(m.id, m.transcripcion);
    const uso = { tokensEntrada: 0, tokensSalida: 0 };
    /* Una a la vez: son pocas, y comparten máquina con las agentes. */
    for (const m of audiosDeLaRafaga(mensajes)) {
      if (m.transcripcion) continue;
      try {
        const audio = await this.audioDe(m.id);
        if (!audio) {
          transcripciones.set(m.id, null);
          continue;
        }
        const r = await this.transcriptor.transcribir(audio);
        uso.tokensEntrada += r.uso.tokensEntrada;
        uso.tokensSalida += r.uso.tokensSalida;
        transcripciones.set(m.id, r.texto);
        /* Solo lo entendido; `null` se vuelve a intentar si vuelve a ser parte de una ráfaga. */
        if (r.texto) await this.prisma.mensaje.updateMany({ where: { id: m.id, transcripcion: null }, data: { transcripcion: r.texto } });
      } catch (error: unknown) {
        /* Un audio que no se pudo escuchar no rompe el turno: se dice que no se escuchó. */
        this.logger.warn(`Nota de voz ${m.id}: ${error instanceof Error ? error.message.slice(0, 200) : 'falló'}`);
        transcripciones.set(m.id, null);
      }
    }
    return { transcripciones, uso };
  }

  private esperaMs(): number {
    const v = Number(this.config.get<string>('ASISTENTE_ESPERA_AUDIO_MS'));
    return Number.isFinite(v) && v >= 0 ? v : ESPERA_AUDIO_POR_DEFECTO_MS;
  }

  /** Los bytes del audio cuando ya están en R2; `null` si no llegaron a tiempo o son demasiados. */
  private async audioDe(mensajeId: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
    if (!this.r2.habilitado) return null;
    const limite = Date.now() + this.esperaMs();
    let fila = await this.prisma.mensaje.findUnique({ where: { id: mensajeId }, select: { mediaKey: true, mediaMime: true } });
    while (!fila?.mediaKey && Date.now() < limite) {
      await new Promise(listo => setTimeout(listo, PASO_ESPERA_MS));
      fila = await this.prisma.mensaje.findUnique({ where: { id: mensajeId }, select: { mediaKey: true, mediaMime: true } });
    }
    if (!fila?.mediaKey) return null;
    const objeto = await this.r2.leer(fila.mediaKey);
    if (!objeto) return null;
    if (objeto.bytes !== null && objeto.bytes > BYTES_MAXIMOS_AUDIO) {
      await objeto.cuerpo.cancel();
      return null;
    }
    const bytes = new Uint8Array(await new Response(objeto.cuerpo).arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > BYTES_MAXIMOS_AUDIO) return null;
    return { bytes, mime: fila.mediaMime ?? objeto.tipo ?? 'audio/ogg' };
  }
}
