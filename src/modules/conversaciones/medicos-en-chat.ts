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
export async function medicosDeTelefonos(db: Pick<Prisma.TransactionClient, 'accesoMedicoAgenda'>, telefonos: ReadonlyArray<string | null>): Promise<Map<string, string>> {
  const unicos = [...new Set(telefonos.filter((t): t is string => !!t))];
  if (!unicos.length) return new Map();
  const filas = await db.accesoMedicoAgenda.findMany({ where: { telefono: { in: unicos } }, select: { telefono: true, nombreMedico: true } });
  return new Map(filas.map(f => [f.telefono, f.nombreMedico]));
}

/** El médico autorizado de ese teléfono, o null. Sin teléfono (solo BSUID) nunca es un médico: se autoriza por número. */
export function medicoDe(medicos: ReadonlyMap<string, string>, telefono: string | null): string | null {
  return telefono ? medicos.get(telefono) ?? null : null;
}
