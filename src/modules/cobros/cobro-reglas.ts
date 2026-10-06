/*
 * El QR con que una línea cobra una promoción por WhatsApp (docs/pagos-promocion.md).
 * Aquí solo las decisiones, sin base ni red: cuándo se puede enviar y qué se le dice
 * a la paciente.
 */

export type EstadoCobro = 'LISTO' | 'APAGADO' | 'SIN_QR' | 'VENCIDO';

/**
 * ¿Se puede ofrecer «Pagar ahora» con este QR hoy? Un QR vencido no se envía: el
 * banco lo rechaza y la paciente ya habría pagado en su cabeza.
 */
export function estadoDelCobro(c: { activo: boolean; imagenId: string | null; venceEl: Date | null }, hoy: Date): EstadoCobro {
  if (!c.imagenId) return 'SIN_QR';
  if (c.venceEl && c.venceEl.getTime() < hoy.getTime()) return 'VENCIDO';
  return c.activo ? 'LISTO' : 'APAGADO';
}

/** Bs con separador de miles y dos decimales solo si hacen falta: «Bs 1.250» o «Bs 260,50». */
export function bolivianos(monto: number): string {
  return `Bs ${new Intl.NumberFormat('es-BO', { minimumFractionDigits: Number.isInteger(monto) ? 0 : 2, maximumFractionDigits: 2 }).format(monto)}`;
}

/**
 * El pie del QR. Dice el monto, a nombre de quién está la cuenta y qué hacer
 * después. No promete plazos: el pago se confirma cuando una persona lo verifica.
 */
export function textoDelQr(p: { titulo: string; monto: number; banco: string; titular: string; instrucciones: string | null }): string {
  return [
    `Para pagar «${p.titulo}»: ${bolivianos(p.monto)}.`,
    `Escanea este QR (${p.banco}, a nombre de ${p.titular}) y envíanos aquí la foto o el PDF del comprobante.`,
    ...(p.instrucciones ? [p.instrucciones] : []),
  ].join('\n');
}
