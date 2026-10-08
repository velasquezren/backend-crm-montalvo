import { puedeVerAgendaClinica } from '../../common/auth/roles';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '../../prisma/prisma-client';
import { whereAccesoConversacion } from '../conversaciones/acceso-conversacion';

/** Las tareas personales siguen siendo privadas. Las de reservas tienen el
 * mismo alcance que su chat; las externas, el de la agenda clínica. */
export async function whereAccesoActividad(prisma: PrismaService, usuarioId?: string): Promise<Prisma.ActividadWhereInput> {
  if (!usuarioId) return {};
  const usuario = await prisma.usuario.findUnique({ where: { id: usuarioId }, select: { rol: true, activo: true } });
  if (!usuario?.activo) return { id: { in: [] } };
  return { OR: [
    { reservaAgenda: null, agenteId: usuarioId },
    { reservaAgenda: { not: null }, reservaDeChat: true, conversacion: whereAccesoConversacion(usuarioId) },
    ...(puedeVerAgendaClinica(usuario.rol) ? [{ reservaAgenda: { not: null }, reservaDeChat: false }] : []),
  ] };
}
