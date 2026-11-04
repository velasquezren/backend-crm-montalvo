/*
 * Qué contestó Meta a un aviso de resultado mientras FileMaker espera.
 *
 * La plantilla sale a Meta en segundo plano (`EnvioPlantillasService`): cuando
 * `entregar` vuelve, el mensaje solo está registrado. Decirle a FileMaker
 * «WhatsApp enviado» en ese momento dejaba el registro en ENVIADO aunque Meta lo
 * rechazara después (131026: número sin WhatsApp). Aquí se lee la fila del
 * mensaje hasta saber algo. Sin imports de servicios a propósito.
 */

/** Lo que importa de la fila `Mensaje` del aviso. */
export interface EstadoEnvioLeido {
  estadoEnvio: string | null;
  whatsappMsgId: string | null;
  codigoErrorEnvio: number | null;
}

export type ConfirmacionAviso =
  /** Meta lo aceptó y no lo rechazó durante la gracia; puede no estar entregado todavía. */
  | { tipo: 'ACEPTADO' }
  | { tipo: 'ENTREGADO' }
  | { tipo: 'RECHAZADO'; codigo: number | null }
  /** Meta no contestó a tiempo: pudo salir. No se debe reenviar. */
  | { tipo: 'SIN_CONFIRMAR' };

export interface EsperaConfirmacion {
  /** Tope de toda la espera. El guion de FileMaker corta a los 60 s. */
  plazoMs: number;
  /**
   * Tras aceptarlo, cuánto más se espera un rechazo: el 131026 llega por el
   * webhook de `statuses`, segundos después de la aceptación.
   */
  graciaMs: number;
  cadaMs: number;
}

export async function esperarConfirmacion(
  leer: () => Promise<EstadoEnvioLeido | null>,
  espera: EsperaConfirmacion,
  reloj: { ahora: () => number; dormir: (ms: number) => Promise<void> } = {
    ahora: () => Date.now(),
    dormir: ms => new Promise(listo => setTimeout(listo, ms)),
  },
): Promise<ConfirmacionAviso> {
  const inicio = reloj.ahora();
  let aceptadoEn: number | null = null;
  for (;;) {
    const fila = await leer();
    if (fila?.estadoEnvio === 'FALLIDO') return { tipo: 'RECHAZADO', codigo: fila.codigoErrorEnvio };
    if (fila?.estadoEnvio === 'ENTREGADO' || fila?.estadoEnvio === 'LEIDO') return { tipo: 'ENTREGADO' };
    const ahora = reloj.ahora();
    if (fila?.whatsappMsgId && aceptadoEn === null) aceptadoEn = ahora;
    if (aceptadoEn !== null && ahora - aceptadoEn >= espera.graciaMs) return { tipo: 'ACEPTADO' };
    if (ahora - inicio >= espera.plazoMs) return aceptadoEn !== null ? { tipo: 'ACEPTADO' } : { tipo: 'SIN_CONFIRMAR' };
    await reloj.dormir(espera.cadaMs);
  }
}

/** Por qué no llegó, en palabras de la asistente (mismos criterios que Conversaciones). */
export function motivoAvisoRechazado(codigo: number | null): string {
  const motivo =
    codigo === 131026 ? 'WhatsApp no pudo entregarlo a ese número: puede no tener WhatsApp. Confirma el número con el paciente.'
    : codigo === 130497 ? 'Meta restringe los envíos al país de ese número.'
    : codigo === 131042 ? 'Meta reporta un problema de facturación de la línea: avisa al administrador.'
    : `WhatsApp rechazó el aviso${codigo ? ` (código ${codigo})` : ''}.`;
  return `${motivo} El informe sigue publicado: míralo en Resultados del CRM.`;
}

export const AVISO_SIN_CONFIRMAR =
  'WhatsApp todavía no confirma el aviso, así que puede que sí haya salido. ' +
  'Míralo en Resultados del CRM antes de hacer otra cosa; volver a pulsar no manda otro.';
