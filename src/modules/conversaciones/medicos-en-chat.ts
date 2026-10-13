import { Prisma } from '../../prisma/prisma-client';

/**
 * Qué conversaciones son de un MÉDICO autorizado a consultar su agenda por el
 * asistente (`AccesoMedicoAgenda`, dueño: módulo agenda). Solo lectura, para
 * rotular el chat: la agente tiene que ver de un vistazo que no es una paciente
 * ni una venta. Una consulta por página, sobre una tabla de decenas de filas.
 *
 * El teléfono de `Cliente` y el del acceso están los dos en E.164 (`normalizarTelefono`),
 * así que la comparación es exacta.
 */
export async function medicosDeTelefonos(db: Pick<Prisma.TransactionClient, 'accesoMedicoAgenda'>, telefonos: readonly string[]): Promise<Map<string, string>> {
  const unicos = [...new Set(telefonos.filter(Boolean))];
  if (!unicos.length) return new Map();
  const filas = await db.accesoMedicoAgenda.findMany({ where: { telefono: { in: unicos } }, select: { telefono: true, nombreMedico: true } });
  return new Map(filas.map(f => [f.telefono, f.nombreMedico]));
}
