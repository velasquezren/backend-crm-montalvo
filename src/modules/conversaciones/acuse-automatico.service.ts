import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { estaAtendiendo, parsearHorario, ZONA_POR_DEFECTO } from './horario-atencion';

/** Lo que hay que mandarle al paciente cuando no hay nadie atendiendo. */
export interface AcuseADespachar {
  texto: string;
  /** null = va como texto plano, sin botonera. */
  botones: string[] | null;
}

/**
 * Decide SI toca mandar un acuse fuera de horario y QUÉ mandar.
 *
 * Separado del envío a propósito. Antes, un solo método de `ConversacionesService`
 * mezclaba tres cosas de naturaleza distinta: leer configuración, razonar sobre
 * la hora y escribir en base. Eso obligaba a levantar Postgres para probar algo
 * tan simple como "un horario mal escrito no debe contestar".
 *
 * Aquí vive solo la DECISIÓN —sin base de datos y sin red—, así que se prueba en
 * milisegundos. El efecto (crear el mensaje, hablar con Meta) se queda donde
 * están las demás escrituras.
 */
@Injectable()
export class AcuseAutomaticoService {
  private readonly logger = new Logger(AcuseAutomaticoService.name);

  constructor(private readonly config: ConfigService) {}

  /** Horas antes de volver a acusar recibo en la misma conversación. */
  get esperaHoras(): number {
    return Number(this.config.get<string>('AUTORESPUESTA_ESPERA_HORAS')) || 12;
  }

  /**
   * `null` significa "no mandes nada", y es la respuesta ante cualquier duda.
   *
   * Callar es reversible; decirle "no hay nadie" a quien escribe un martes a las
   * diez, no. Por eso un horario mal escrito apaga la función en vez de disparar
   * a ciegas.
   */
  decidir(ahora: Date): AcuseADespachar | null {
    const texto = this.config.get<string>('AUTORESPUESTA_TEXTO')?.trim();
    /* Sin texto la función está apagada. No hay uno por defecto a propósito: el
       mensaje lleva el teléfono de urgencias de la clínica, y uno inventado
       mandaría a un paciente urgente a un número equivocado. */
    if (!texto) return null;

    const horario = parsearHorario(
      this.config.get<string>('AUTORESPUESTA_HORARIO'),
      this.config.get<string>('AUTORESPUESTA_ZONA') || ZONA_POR_DEFECTO,
    );
    if (!horario) {
      this.logger.warn(
        'AUTORESPUESTA_HORARIO ausente o mal escrito: no se enviará ningún acuse automático.',
      );
      return null;
    }

    if (estaAtendiendo(ahora, horario)) return null;

    return { texto, botones: leerBotones(this.config.get<string>('AUTORESPUESTA_BOTONES')) };
  }
}

/**
 * Botones del acuse, leídos de `AUTORESPUESTA_BOTONES` ("Agendar cita|Resultados").
 *
 * Meta acepta **como mucho 3 botones de 20 caracteres**. Si algo no encaja se
 * devuelve `null` y el acuse sale como texto plano: un `interactive` malformado
 * lo rechaza Meta ENTERO, así que el paciente no recibiría nada — peor que no
 * tener botones. Ante la duda, degradar en vez de fallar.
 */
export function leerBotones(texto: string | undefined): string[] | null {
  const botones = (texto ?? '')
    .split('|')
    .map(b => b.trim())
    .filter(Boolean);

  if (botones.length === 0 || botones.length > 3) return null;
  if (botones.some(b => b.length > 20)) return null;
  /* Meta rechaza dos botones con el mismo título. */
  if (new Set(botones).size !== botones.length) return null;

  return botones;
}
