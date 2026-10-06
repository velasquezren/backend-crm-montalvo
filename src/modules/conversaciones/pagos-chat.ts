import { createHash } from 'node:crypto';

import { EstadoPagoPromocion, Prisma } from '../../prisma/prisma-client';

/*
 * Lecturas del pago de una promoción en el chat (docs/pagos-promocion.md) que
 * comparten el detalle de la conversación y `PagosChatService`. Solo leen.
 */

/** Los estados en que el pago sigue en curso: como mucho uno por conversación. */
export const PAGO_ABIERTO: readonly EstadoPagoPromocion[] = ['PENDIENTE', 'COMPROBANTE_ENVIADO'];

/**
 * Cuánto se espera el comprobante de un pago pedido (desde el QR o desde que se
 * pidió otro). Pasado esto, una imagen que llega es solo una imagen; el pago sigue
 * PENDIENTE en el chat y una persona lo retoma o lo anula.
 */
export const HORAS_ESPERA_COMPROBANTE = 72;

/** Cuánto sigue visible en el chat un pago ya cerrado (confirmado o anulado). */
const DIAS_VISIBLE_CERRADO = 14;

const SELECT_PAGO = {
  id: true,
  estado: true,
  monto: true,
  comprobanteMensajeId: true,
  motivoRechazo: true,
  ventaId: true,
  cerradoEn: true,
  createdAt: true,
  promocion: { select: { id: true, titulo: true, codigo: true } },
  cerradoPor: { select: { id: true, nombre: true } },
} satisfies Prisma.PagoPromocionSelect;

export interface PagoDelChat {
  id: string;
  estado: EstadoPagoPromocion;
  monto: number;
  promocion: { id: string; titulo: string; codigo: string };
  comprobanteMensajeId: string | null;
  motivoRechazo: string | null;
  ventaId: string | null;
  cerradoPor: { id: string; nombre: string } | null;
  cerradoEn: Date | null;
  createdAt: Date;
}

/**
 * El pago que se muestra en el chat: el abierto, o el último cerrado de los
 * últimos días (para que quien abre el chat vea «Pago confirmado por Ana»).
 * Se lee siempre acotado a la conversación, después de comprobar el acceso.
 */
export async function pagoDelChat(db: Prisma.TransactionClient, conversacionId: string): Promise<PagoDelChat | null> {
  const desde = new Date(Date.now() - DIAS_VISIBLE_CERRADO * 86_400_000);
  const abierto = await db.pagoPromocion.findFirst({
    where: { conversacionId, estado: { in: [...PAGO_ABIERTO] } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: SELECT_PAGO,
  });
  const fila = abierto ?? await db.pagoPromocion.findFirst({
    where: { conversacionId, cerradoEn: { gte: desde } },
    orderBy: [{ cerradoEn: 'desc' }, { id: 'desc' }],
    select: SELECT_PAGO,
  });
  return fila ? { ...fila, monto: fila.monto.toNumber() } : null;
}

/**
 * Dentro de la transacción de la ingesta: si había un pago esperando su
 * comprobante, esta imagen o documento lo es. Compare-and-set: dos fotos
 * simultáneas no marcan dos comprobantes. Es una función y no un método de
 * servicio porque corre con CADA foto que llega y no necesita más que la base.
 */
export async function registrarComprobante(tx: Prisma.TransactionClient, conversacionId: string, mensajeId: string, ahora = new Date()): Promise<boolean> {
  const { count } = await tx.pagoPromocion.updateMany({
    /* Solo un pago pedido hace poco: una foto semanas después (una ecografía, una
       orden médica) no es el comprobante de un QR que se le mandó entonces. */
    where: { conversacionId, estado: 'PENDIENTE', updatedAt: { gte: new Date(ahora.getTime() - HORAS_ESPERA_COMPROBANTE * 3_600_000) } },
    data: { estado: 'COMPROBANTE_ENVIADO', comprobanteMensajeId: mensajeId, motivoRechazo: null },
  });
  return count > 0;
}

/**
 * La promoción por la que llegó esta paciente por su código (`Lead.promocionId`),
 * para la etiqueta del chat. Solo la línea comercial tiene leads.
 */
export async function promocionDelChat(db: Prisma.TransactionClient, clienteId: string): Promise<{ id: string; titulo: string; codigo: string } | null> {
  const lead = await db.lead.findFirst({
    where: { clienteId, promocionId: { not: null } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { promocion: { select: { id: true, titulo: true, codigo: true } } },
  });
  return lead?.promocion ?? null;
}

/**
 * Un UUID estable a partir de un texto: la clave de idempotencia del mensaje que
 * avisa una confirmación. Reintentar la confirmación no le escribe dos veces.
 */
export function uuidEstable(texto: string): string {
  const h = createHash('sha256').update(texto).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
