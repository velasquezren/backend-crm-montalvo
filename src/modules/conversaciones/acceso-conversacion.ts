import { Prisma } from "../../prisma/prisma-client";
import { ROLES_OPERATIVOS } from "../../common/auth/roles";
import type { PrismaService } from "../../prisma/prisma.service";

/**
 * Una conversación por paciente + línea. La reserva comercial nace en el mismo
 * INSERT; una conversación anterior nunca se rearma por un reintento.
 *
 * `upsert` NO sirve: internamente hace "buscar → insertar" y bajo carrera real
 * uno de los dos inserts choca igual contra el índice único. El patrón correcto
 * es intentar crear y, si rebota (P2002), releer: para entonces la otra
 * petición ya lo creó.
 *
 * Es función y no método de un service a propósito: la ingesta del webhook y la
 * entrega de resultados necesitan exactamente este gesto, y dos copias
 * divergen. Colgarlo de `ConversacionesService` obligaría a montar ese servicio
 * entero —ocho dependencias— solo para crear una fila.
 */
export async function obtenerOCrearConversacion(
  db: PrismaService,
  clienteId: string,
  lineaId: string,
  comercial: boolean,
): Promise<{ id: string; agenteId: string | null }> {
  const existente = await db.conversacion.findUnique({ where: { clienteId_lineaId: { clienteId, lineaId } } });
  if (existente) return existente;
  try {
    return await db.conversacion.create({
      data: { clienteId, lineaId, ...(comercial ? { primerContacto: { create: {} } } : {}) },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const yaCreada = await db.conversacion.findUnique({ where: { clienteId_lineaId: { clienteId, lineaId } } });
      if (yaCreada) return yaCreada;
    }
    throw error;
  }
}

/** La línea es un permiso obligatorio, independiente de asignación y filtros. */
export function whereAccesoConversacion(
  usuarioId?: string,
): Prisma.ConversacionWhereInput {
  if (!usuarioId) return {};
  return {
    linea: { usuarios: { some: { usuarioId } } },
    OR: [
      // Un rol operativo comparte la atención de su línea, aunque el chat tenga responsable.
      { linea: { usuarios: { some: { usuarioId, usuario: { rol: { in: [...ROLES_OPERATIVOS] } } } } } },
      { agenteId: usuarioId },
      { agenteId: null },
      { linea: { comercial: true }, cliente: { agenteId: usuarioId } },
    ],
  };
}

export const SELECT_LINEA = {
  id: true,
  nombre: true,
  telefono: true,
  activa: true,
  comercial: true,
} satisfies Prisma.LineaWhatsappSelect;

export const LINEA_COMERCIAL_INICIAL = "00000000-0000-4000-8000-000000000001";
