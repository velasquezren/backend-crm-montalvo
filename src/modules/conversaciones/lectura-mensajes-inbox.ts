import { Prisma } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import { MensajeDeInbox } from './consultas-inbox';

/**
 * Como máximo un mensaje por chat, limitado EN PostgreSQL.
 * Prisma `take: 1` sobre una relación puede traer todos sus mensajes y reducir
 * en memoria. LATERAL permite buscar por el índice (conversacionId, createdAt)
 * solo para los IDs de la página que ya pasó los permisos del inbox.
 * El desempate por ID coincide con el historial: ni siquiera dos mensajes
 * con la misma fecha pueden alternar la vista previa entre refrescos.
 */
export async function ultimosMensajesDeInbox(
  prisma: PrismaService,
  idsAutorizados: readonly string[],
): Promise<Map<string, MensajeDeInbox>> {
  if (!idsAutorizados.length) return new Map();
  const filas = await prisma.$queryRaw<(MensajeDeInbox & { conversacionId: string })[]>(Prisma.sql`
    SELECT m.* FROM "Conversacion" c
    CROSS JOIN LATERAL (
      SELECT "conversacionId", id, contenido, direccion, "estadoEnvio",
        "codigoErrorEnvio", tipo, automatico, "createdAt", "mediaNombre"
      FROM "Mensaje" WHERE "conversacionId" = c.id
      ORDER BY "createdAt" DESC, id DESC LIMIT 1
    ) m
    WHERE c.id IN (${Prisma.join(idsAutorizados)})
  `);
  return new Map(filas.map(({ conversacionId, ...mensaje }) => [conversacionId, mensaje]));
}
