import { Prisma } from "../../prisma/prisma-client";

/** La línea es un permiso obligatorio, independiente de asignación y filtros. */
export function whereAccesoConversacion(
  usuarioId?: string,
): Prisma.ConversacionWhereInput {
  if (!usuarioId) return {};
  return {
    linea: { usuarios: { some: { usuarioId } } },
    OR: [
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
