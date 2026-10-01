import { ZONA_CLINICA } from '../../common/fechas/zona-clinica';
import { esNombreProvisional } from '../clientes/clientes.service';

/*
 * Las reglas de una campaña, sin base ni Nest: lo que se puede probar solo.
 *
 * Una campaña manda UNA plantilla de Marketing a una audiencia congelada, a
 * ritmo y en horario. Todo lo que aquí es número se eligió por una razón de
 * Meta o de la clínica; si se cambia, que sea con la razón a la vista.
 */

/**
 * Horario de envío en La Paz: de 9:00 a 19:59. Una promoción a las 23:00 se
 * lee como abuso y se bloquea o se reporta, y eso baja la calidad de la línea
 * para TODAS sus plantillas. Fuera de horario la campaña espera, no se salta.
 */
export const HORARIO_ENVIO = { desdeHora: 9, hastaHora: 20 } as const;

/** Cada cuánto despierta el barrido, y cuántas manda como mucho en cada vuelta: 80 por minuto. */
export const INTERVALO_ENVIO_MS = 15_000;
export const LOTE_POR_VUELTA = 20;

/**
 * Tope de pacientes por campaña. Meta limita a cuántas personas distintas
 * puede escribirle una línea por día (250, 1.000, 10.000… según su historial)
 * y pasarse deja mensajes sin entregar. 2.000 cubre las audiencias de hoy
 * (Gold y Silver son decenas) sin arriesgar la línea.
 */
export const MAXIMO_DESTINATARIOS = 2_000;

/** Ventanas de atribución: respondió en 7 días, compró en 30. */
export const VENTANA_RESPUESTA_DIAS = 7;
export const VENTANA_COMPRA_DIAS = 30;

/** De dónde sale el valor de cada variable de la plantilla. */
export type VariableCampana =
  /** El nombre de pila de la paciente; `respaldo` si no lo tiene (contacto sin nombre). */
  | { readonly tipo: 'NOMBRE'; readonly respaldo: string }
  /** El mismo texto para todas. */
  | { readonly tipo: 'TEXTO'; readonly texto: string };

/**
 * El nombre de pila, o `null` si la ficha no tiene uno de verdad. Un contacto
 * que escribió sin presentarse se guarda como «WhatsApp +591…»: saludarlo
 * así es peor que no nombrarlo.
 */
export function nombreDePila(nombre: string): string | null {
  if (esNombreProvisional(nombre)) return null;
  const primero = nombre.trim().split(/\s+/)[0] ?? '';
  if (!primero) return null;
  return primero.charAt(0).toLocaleUpperCase('es') + primero.slice(1).toLocaleLowerCase('es');
}

/** Los parámetros de la plantilla para una paciente, en el orden de Meta. */
export function parametrosPara(variables: readonly VariableCampana[], nombre: string): string[] {
  return variables.map(v => (v.tipo === 'NOMBRE' ? (nombreDePila(nombre) ?? v.respaldo) : v.texto).trim());
}

/** ¿Es hora de mandar promociones en La Paz? */
export function dentroDeHorario(instante: Date): boolean {
  const hora = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: ZONA_CLINICA, hour: '2-digit', hour12: false }).format(instante),
  ) % 24;
  return hora >= HORARIO_ENVIO.desdeHora && hora < HORARIO_ENVIO.hastaHora;
}
