import { Prisma } from '../../prisma/prisma-client';
import { CierreReserva } from '../../common/whatsapp/flows/token-flow';
import { interaccionesEnLinea } from './interacciones-integracion';
import { CANDADO_AUTOMATICOS } from './atencion-humana';
import { HORAS_ESPERA_COMPROBANTE, uuidEstable } from './pagos-chat';

/*
 * Las reservas que una paciente hizo con el Flow de WhatsApp, vistas desde su
 * chat (`ReservaChat`). La reserva vive en la agenda (`para_agendar`); aquí solo
 * queda lo que el chat necesita para cobrarla: qué QR se le mandó, por cuánto, y
 * qué imagen mandó ella como comprobante. Llevar ese comprobante a la agenda lo
 * hace `ComprobantesReservaChatService`, fuera de la transacción del mensaje.
 *
 * Son funciones y no un service por lo mismo que `registrarComprobante`: corren
 * dentro de la transacción de la ingesta y no necesitan más que la base.
 */

/** El QR que se le manda al reservar, con el texto que lo acompaña. */
export interface PagoDeReserva {
  reserva: number;
  mensajeId: string;
  texto: string;
  media: { key: string; mime: string; nombre: string };
}

const MIME_QR: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

/** «Bs 250» o «Bs 250,50», como lo dice el Flow. */
export function textoBs(centavos: number): string {
  const bs = centavos / 100;
  return `Bs ${bs.toLocaleString('es-BO', { minimumFractionDigits: Number.isInteger(bs) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

export function textoPagoDeReserva(reserva: number, centavos: number): string {
  return `Tu reserva N.º ${reserva} quedó registrada. Para asegurarla, paga ${textoBs(centavos)} con este QR y mándanos por aquí la foto o captura del comprobante. Recepción confirmará tu cita por este chat.`;
}

export const TEXTO_COMPROBANTE_RESERVA = '✅ Recibimos tu comprobante. Recepción lo verificará y te confirmará la cita por aquí.';

/**
 * Dentro de la transacción de la ingesta, al llegar el cierre del Flow ya
 * verificado. Lo que devuelve es el QR que hay que mandarle, si la reserva se
 * cobra por el chat; `null` si no (el médico no tiene precio o QR vigente, o
 * este cierre ya se había registrado: Meta repite webhooks).
 */
export async function registrarReservaDeChat(tx: Prisma.TransactionClient, conversacionId: string, cierre: CierreReserva): Promise<PagoDeReserva | null> {
  const chat = await tx.conversacion.findUnique({ where: { id: conversacionId }, select: { lineaId: true, cliente: { select: { telefono: true } } } });
  if (!chat || !interaccionesEnLinea(chat.lineaId) || chat.cliente.telefono.replace(/^\+/, '') !== cierre.telefono) return null;
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${conversacionId}, ${CANDADO_AUTOMATICOS}))::text`;
  const { montoCentavos, qrClave } = cierre;
  const cobra = montoCentavos !== null && qrClave !== null;
  /* ON CONFLICT DO NOTHING: un P2002 dentro de la transacción la abortaría entera. */
  const { count } = await tx.reservaChat.createMany({
    data: {
      conversacionId,
      reservaAgenda: cierre.reserva,
      monto: cobra ? new Prisma.Decimal(montoCentavos).div(100) : null,
      qrClave: cobra ? qrClave : null,
      estado: cobra ? 'ESPERANDO_COMPROBANTE' : 'SIN_PAGO',
    },
    skipDuplicates: true,
  });
  if (count === 0 || !cobra) return null;
  const mime = MIME_QR[qrClave.slice(qrClave.lastIndexOf('.') + 1)] ?? 'image/png';
  const texto = textoPagoDeReserva(cierre.reserva, montoCentavos);
  // Intención durable EN LA MISMA transacción que el webhook y ReservaChat.
  // El despachador existente reclama el envío; los inciertos nunca se repiten.
  const mensaje = await tx.mensaje.create({ data: {
    conversacionId, direccion: 'SALIENTE', tipo: 'IMAGEN', automatico: true,
    contenido: texto, mediaKey: qrClave, mediaMime: mime, mediaNombre: 'QR de pago',
    clientMessageId: uuidEstable(`reserva-qr:${cierre.reserva}`), estadoEnvio: 'FALLIDO',
    proximoIntento: new Date(),
  } });
  await tx.reservaChat.update({ where: { reservaAgenda: cierre.reserva }, data: { qrMensajeId: mensaje.id } });
  return {
    mensajeId: mensaje.id,
    reserva: cierre.reserva,
    texto,
    media: { key: qrClave, mime, nombre: 'QR de pago' },
  };
}

/**
 * Dentro de la transacción de la ingesta: si una reserva de este chat espera su
 * comprobante y es la única pendiente, esta imagen o documento puede asociarse.
 * Compare-and-set, como `registrarComprobante`: dos fotos simultáneas no marcan
 * dos comprobantes, y una foto semanas después no es el pago de aquel QR.
 */
export async function marcarComprobanteDeReserva(tx: Prisma.TransactionClient, conversacionId: string, mensajeId: string, ahora = new Date()): Promise<boolean> {
  const desde = new Date(ahora.getTime() - HORAS_ESPERA_COMPROBANTE * 3_600_000);
  const chat = await tx.conversacion.findUnique({ where: { id: conversacionId }, select: { lineaId: true } });
  if (!chat || !interaccionesEnLinea(chat.lineaId)) return false;
  // Dos reservas esperando NO autorizan escoger la última. Se revisan a mano.
  const esperas = await tx.reservaChat.findMany({
    where: { conversacionId, estado: 'ESPERANDO_COMPROBANTE', createdAt: { gte: desde } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 2,
    select: { id: true, qrMensaje: { select: { whatsappMsgId: true, estadoEnvio: true } } },
  });
  if (esperas.length !== 1 || !esperas[0].qrMensaje?.whatsappMsgId
    || !['ENVIADO','ENTREGADO','LEIDO'].includes(esperas[0].qrMensaje.estadoEnvio ?? "")) return false;
  const propio = await tx.mensaje.findFirst({ where: { id: mensajeId, conversacionId, direccion: 'ENTRANTE' }, select: { id: true } });
  if (!propio) return false;
  const { count } = await tx.reservaChat.updateMany({
    where: { id: esperas[0].id, estado: 'ESPERANDO_COMPROBANTE' },
    data: { estado: 'COMPROBANTE_RECIBIDO', comprobanteMensajeId: mensajeId, comprobanteRecibidoEn: ahora, proximoIntento: ahora },
  });
  return count > 0;
}

/** Nunca adivinar si una foto paga una promoción o alguna de varias reservas. */
export async function comprobanteAmbiguo(tx: Prisma.TransactionClient, conversacionId: string): Promise<boolean> {
  const desde = new Date(Date.now() - HORAS_ESPERA_COMPROBANTE * 3_600_000);
  const reservas = await tx.reservaChat.count({ where: { conversacionId, estado: 'ESPERANDO_COMPROBANTE', createdAt: { gte: desde } } });
  if (!reservas) return false;
  const promociones = await tx.pagoPromocion.count({ where: { conversacionId, estado: 'PENDIENTE', updatedAt: { gte: desde } } });
  return reservas + promociones > 1;
}
