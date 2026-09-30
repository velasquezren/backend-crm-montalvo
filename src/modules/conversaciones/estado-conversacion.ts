import { Prisma } from '../../prisma/prisma-client';

/**
 * Abierta o cerrada: el estado de una conversación, en un solo sitio.
 *
 * Cerrada = resuelta. Sale de las pestañas de trabajo —y de sus contadores y
 * del Dashboard— y se reabre sola en cuanto hay actividad humana: escribe la
 * paciente o contesta la clínica. Así cerrar nunca pierde a nadie. Es el
 * modelo de Intercom o Front.
 *
 * Existe porque sin estado «Sin responder» acumulaba todo lo que alguna vez
 * quedó sin contestar —427 el 2026-09-30, 201 de ellos sin movimiento hacía
 * más de una semana—, y el Dashboard repetía el mismo número.
 */

/** Las conversaciones que cuentan como trabajo: abiertas. */
export const ABIERTA = { cerradaEn: null } satisfies Prisma.ConversacionWhereInput;

/**
 * «Sin responder» de verdad: abierta y con la paciente esperando a una persona.
 * La usan el inbox y el Dashboard; si cada uno escribiera la suya, volverían a
 * decir números distintos.
 */
export const SIN_RESPONDER = { ...ABIERTA, esperandoRespuesta: true } satisfies Prisma.ConversacionWhereInput;

/** Lo que se escribe al haber actividad humana: la conversación vuelve a estar abierta. */
export const REABRIR = { cerradaEn: null, cerradaPorId: null } satisfies Prisma.ConversacionUncheckedUpdateManyInput;

/**
 * Días sin ningún mensaje tras los que el barrido la cierra sola. A esa altura
 * la ventana de 24 h de WhatsApp venció hace mucho: solo se le puede escribir
 * con una plantilla de pago, y si vuelve a escribir, se reabre.
 */
export const DIAS_INACTIVIDAD_POR_DEFECTO = 30;

export function diasDeInactividad(valor: string | undefined): number {
  const dias = Number(valor);
  return Number.isInteger(dias) && dias >= 1 ? dias : DIAS_INACTIVIDAD_POR_DEFECTO;
}
