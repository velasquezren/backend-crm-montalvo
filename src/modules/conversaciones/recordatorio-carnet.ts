/*
 * Pedido de René (10/11/2026): a quien reserva o paga por WhatsApp una consulta
 * con el Dr. Montalvo se le recuerda traer el carnet. Solo con él. Lo dice el
 * texto que acompaña al QR (al reservar) y el de la constancia (al pagar).
 *
 * Es `medicos.medico_pk` de la agenda ScriptCase, no el nombre: «Montalvo» también
 * son el Dr. Montalvo Pérez y las Lic. Angulo Montalvo. Sumar otro médico es
 * sumar su número aquí.
 */
const MEDICOS_QUE_PIDEN_CARNET: ReadonlySet<number> = new Set([
  1, // Juan Carlos Montalvo Doria Medina (Med26)
]);

export const RECORDATORIO_CARNET = 'Por favor, traiga su carnet de identidad el día de la consulta.';

export function pideCarnet(medicoId: number | null | undefined): boolean {
  return medicoId != null && MEDICOS_QUE_PIDEN_CARNET.has(medicoId);
}
