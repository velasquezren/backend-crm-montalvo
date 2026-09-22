import { Prisma } from "../../prisma/prisma-client";
import { ROLES_OPERATIVOS } from "../../common/auth/roles";

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
