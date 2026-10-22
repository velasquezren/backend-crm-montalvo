/*
 * El comprobante de una CITA reservada por el chat, leído por la IA antes de
 * llevarlo a la agenda. Mismas reglas que los pagos de promociones
 * (`asistente/comprobante.ts`): el modelo lee y este código compara.
 *
 * La diferencia es lo que se hace con el resultado. En una promoción la lectura
 * solo ayuda a quien confirma; en una cita, el comprobante pasa solo a la agenda
 * (`para_agendar` en PAGADO, para caja). Por eso aquí la lectura DECIDE si se
 * registra solo: únicamente lo que coincide en todo. Lo demás lo ve una persona.
 */
import { evaluarComprobante, LecturaComprobante } from '../asistente/comprobante';
import type { DatosComprobante } from '../asistente/modelo.port';

export interface EsperadoReserva {
  /** En Bs: lo que se le pidió al mandarle el QR. */
  readonly monto: number;
  /** Cuando se le mandó el QR. */
  readonly pedidoEn: Date;
  readonly ahora: Date;
  /** Esa referencia ya llegó en otro pago (cita o promoción). */
  readonly referenciaRepetida: boolean;
}

export function evaluarComprobanteDeReserva(d: DatosComprobante, e: EsperadoReserva): Pick<LecturaComprobante, 'verificaciones' | 'resultado'> {
  const evaluado = evaluarComprobante(d, { ...e, titular: null });
  if (evaluado.resultado === 'NO_ES_COMPROBANTE') return evaluado;
  /* El QR de la agenda (`pagos_qr`) no dice a nombre de quién está: no hay con
     qué comparar el destinatario, y sin titular esa fila siempre saldría «mirar».
     Caja lo ve en la imagen, que es donde se verifica. */
  const verificaciones = evaluado.verificaciones.filter(v => v.campo !== 'DESTINATARIO');
  return { verificaciones, resultado: verificaciones.every(v => v.estado === 'OK') ? 'COINCIDE' : 'REVISAR' };
}

/**
 * - `REGISTRAR`: es un comprobante, el monto es el pedido, la fecha es posterior
 *   al QR y la operación no llegó antes. Sigue el camino de siempre a la agenda.
 * - `PEDIR_OTRO`: la imagen no es un comprobante (una foto, el carnet): la reserva
 *   vuelve a esperar y se le pide el comprobante. Solo la primera vez.
 * - `REVISAR`: todo lo demás, y una segunda imagen que tampoco lo es. No se carga
 *   nada en la agenda; lo decide una persona con la lectura a la vista.
 */
export type DecisionComprobante = 'REGISTRAR' | 'PEDIR_OTRO' | 'REVISAR';

export function decidirComprobanteDeReserva(lectura: Pick<LecturaComprobante, 'resultado'>, anterior: Pick<LecturaComprobante, 'resultado' | 'mensajeId'> | null): DecisionComprobante {
  if (lectura.resultado === 'COINCIDE') return 'REGISTRAR';
  if (lectura.resultado === 'NO_ES_COMPROBANTE') return anterior?.resultado === 'NO_ES_COMPROBANTE' ? 'REVISAR' : 'PEDIR_OTRO';
  return 'REVISAR';
}

/** `ReservaChat.detalle` (300): lo que no cuadró, primero lo grave. */
export function detalleDeLectura(lectura: Pick<LecturaComprobante, 'resultado' | 'verificaciones'>): string {
  if (lectura.resultado === 'NO_ES_COMPROBANTE') return 'La IA no reconoce la imagen como comprobante de pago (ya se le había pedido otro). Revísala en el chat.';
  const pendientes = [...lectura.verificaciones.filter(v => v.estado === 'ALERTA'), ...lectura.verificaciones.filter(v => v.estado === 'ADVERTENCIA')];
  const texto = `La IA no lo dio por bueno: ${pendientes.map(v => v.texto).join(' ')} No se cargó en la agenda.`;
  return texto.length <= 300 ? texto : `${texto.slice(0, 299)}…`;
}

/** Lo que se le dice cuando la imagen no es un comprobante. De usted, sin culpa. */
export const TEXTO_NO_ES_COMPROBANTE =
  'La imagen que nos envió no parece un comprobante de pago. Cuando realice el pago con el QR, envíenos por aquí la foto o captura del comprobante, por favor.';

/** La lectura guardada, si tiene la forma esperada. */
export function lecturaGuardada(valor: unknown): LecturaComprobante | null {
  if (!valor || typeof valor !== 'object') return null;
  const l = valor as Partial<LecturaComprobante>;
  return l.version === 1 && typeof l.mensajeId === 'string' && Array.isArray(l.verificaciones)
    && (l.resultado === 'COINCIDE' || l.resultado === 'REVISAR' || l.resultado === 'NO_ES_COMPROBANTE') ? l as LecturaComprobante : null;
}
