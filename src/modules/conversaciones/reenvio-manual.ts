import { PrismaService } from '../../prisma/prisma.service';
import { ERROR_BAJA_MARKETING } from '../../common/whatsapp/error-envio';

/*
 * «Reenviar» un mensaje que Meta rechazó, a pedido de una persona, cuando la
 * causa ya se resolvió: la cuenta de Meta impaga (131042), la red, un adjunto que
 * no se pudo firmar… El 9/10/2026 siete respuestas de Recepción quedaron «No
 * enviado» por la facturación de Meta; pagada la cuenta, reenviarlas exigió tocar
 * la base a mano. Esto lo pone en el chat.
 *
 * Funciones y no un servicio para que la prueba de integración pueda atacar la
 * reclamación directamente contra PostgreSQL (como `ReintentoSalienteService.reclamar`).
 */

/**
 * Rechazos que reenviar NO arregla: la causa no está en la clínica.
 * - 131050: la paciente paró las promociones desde WhatsApp.
 * - 130497: Meta no envía a ese país desde esta cuenta.
 * - 131026: ese número no puede recibir (no tiene WhatsApp, versión vieja…).
 */
const NO_SE_ARREGLA_REENVIANDO: ReadonlySet<number> = new Set([ERROR_BAJA_MARKETING, 130497, 131026]);

export interface MensajeReenviable {
  estadoEnvio: string | null;
  codigoErrorEnvio: number | null;
  automatico: boolean;
  plantillaCategoria: string | null;
  tieneInteraccion: boolean;
}

/**
 * Por qué este mensaje no se puede reenviar a mano, o `null` si se puede. La
 * ventana de 24 h la comprueba quien llama, con la misma regla que un envío.
 */
export function motivoParaNoReenviar(m: MensajeReenviable): string | null {
  if (m.estadoEnvio !== 'FALLIDO') return 'Ese mensaje ya no figura como no enviado.';
  /* Una plantilla cuesta y lleva variables: se manda otra desde «Plantilla». */
  if (m.plantillaCategoria) return 'Una plantilla se vuelve a enviar desde «Plantilla».';
  /* Los manda el CRM (menú, acuses, QR); su reintento es del barrido. */
  if (m.automatico || m.tieneInteraccion) return 'Los mensajes automáticos los reintenta el CRM solo.';
  if (m.codigoErrorEnvio !== null && NO_SE_ARREGLA_REENVIANDO.has(m.codigoErrorEnvio)) {
    return 'WhatsApp no lo entregaría aunque se reenvíe: la causa está del lado de la paciente.';
  }
  return null;
}

/**
 * Se queda con la fila para reenviarla, o descubre que otro se la llevó.
 *
 * Pasa a INCIERTO —sin `whatsappMsgId`: el intento nuevo todavía no lo tiene—
 * con un `updateMany` condicionado al estado Y a `intentosEnvio` leído. Así,
 * de dos toques simultáneos exactamente uno reenvía, y si el barrido de
 * reintentos reclamó antes (incrementa `intentosEnvio` sin cambiar el estado)
 * la versión ya no coincide y aquí no se manda nada. Si el proceso cae entre
 * esto y Meta, la fila queda «Sin confirmar»: la verdad, no un falso «enviado».
 *
 * `intentosEnvio` vuelve a 0: es un envío nuevo de una persona, y si falla por
 * la red el barrido tiene sus tres intentos como con cualquier otro.
 *
 * La constancia (quién reenvió y qué rechazo tenía) va en la MISMA transacción.
 */
export async function reclamarReenvio(
  prisma: PrismaService,
  m: { id: string; conversacionId: string; intentosEnvio: number; codigoErrorEnvio: number | null },
  usuarioId: string,
): Promise<boolean> {
  return prisma.$transaction(async tx => {
    const { count } = await tx.mensaje.updateMany({
      where: { id: m.id, estadoEnvio: 'FALLIDO', intentosEnvio: m.intentosEnvio },
      data: {
        estadoEnvio: 'INCIERTO', whatsappMsgId: null, codigoErrorEnvio: null,
        proximoIntento: null, permiteReintento: true, intentosEnvio: 0,
      },
    });
    if (!count) return false;
    await tx.auditLog.create({
      data: {
        entidad: 'Mensaje', entidadId: m.id, accion: 'MENSAJE_REENVIADO', usuarioId,
        cambios: { conversacionId: m.conversacionId, codigoErrorEnvio: m.codigoErrorEnvio },
      },
    });
    return true;
  });
}
