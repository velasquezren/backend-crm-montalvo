import { ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EstadoPeriodo, Prisma } from '../../prisma/prisma-client';
import { AuditService } from '../../common/audit/audit.service';

const CONFLICTO = 'Hay otra operación del periodo en curso o los datos cambiaron. Actualiza los datos y vuelve a intentarlo.';

/** Frontera financiera: una instantánea para todas las lecturas del comando. */
export async function transaccionFinanciera<T>(
  prisma: PrismaService,
  publicar: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  try {
    return await prisma.$transaction(publicar, {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: 30_000,
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      // Prisma 7 + adapter-pg conserva el SQLSTATE de consultas raw en cause.
      const adaptador = error.meta?.driverAdapterError;
      const causa = adaptador && typeof adaptador === 'object' && 'cause' in adaptador ? adaptador.cause : undefined;
      const codigoSql = error.meta?.code ??
        (causa && typeof causa === 'object' && 'originalCode' in causa ? causa.originalCode : undefined);
      if (error.code === 'P2034' || (error.code === 'P2010' && ['40001', '40P01'].includes(String(codigoSql)))) {
        throw new ConflictException(CONFLICTO);
      }
    }
    throw error;
  }
}

/** La misma clave de F02, incluso cuando el mes aún no tiene fila. */
export async function bloquearPeriodo(tx: Prisma.TransactionClient, anio: number, mes: number) {
  const [bloqueo] = await tx.$queryRaw<Array<{ adquirido: boolean }>>`
    SELECT pg_try_advisory_xact_lock(202602, ${anio * 12 + mes}::int) AS adquirido
  `;
  if (!bloqueo.adquirido) throw new ConflictException(CONFLICTO);

  // REPEATABLE READ puede tomar su snapshot justo antes de que el dueño
  // anterior libere el advisory lock. Esta escritura, sin cambiar valores,
  // hace que PostgreSQL rechace esa instantánea antigua (40001). También
  // cubre comandos que solo agregan firmas y no cambian el estado.
  await tx.$executeRaw`
    UPDATE "PeriodoComision" SET "estado" = "estado" WHERE "anio" = ${anio} AND "mes" = ${mes}
  `;
}

export async function conPeriodoBloqueado<T>(
  prisma: PrismaService,
  id: string,
  publicar: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  // Solo se obtiene la clave inmutable. Estado y contenido se releen dentro.
  const clave = await prisma.periodoComision.findUnique({ where: { id }, select: { anio: true, mes: true } });
  if (!clave) throw new NotFoundException(`Periodo ${id} no encontrado`);
  return transaccionFinanciera(prisma, async tx => {
    await bloquearPeriodo(tx, clave.anio, clave.mes);
    const existe = await tx.periodoComision.findUnique({ where: { id }, select: { id: true } });
    if (!existe) throw new ConflictException('El periodo fue eliminado o reemplazado. Actualiza los datos.');
    return publicar(tx);
  });
}

/** Evidencia que debe sobrevivir cuando se retiran firmas o resultados. */
export async function fotoFinanciera(tx: Prisma.TransactionClient, id: string) {
  return tx.periodoComision.findUniqueOrThrow({
    where: { id },
    include: { resultados: true, aprobaciones: true },
  });
}

/** Solo se invoca después de validar editabilidad y tomar el lock del mes. */
export async function invalidarCalculo(
  tx: Prisma.TransactionClient,
  periodoId: string,
  motivo: string,
  usuarioId?: string,
) {
  const anterior = await fotoFinanciera(tx, periodoId);
  if (anterior.calculadoEn || anterior.configuracionUsada || anterior.resultados.length || anterior.aprobaciones.length) {
    await AuditService.registrarFinanciero(tx, 'PeriodoComision', periodoId, 'INVALIDAR_CALCULO', usuarioId, { motivo, anterior });
  }
  await tx.resultadoComision.deleteMany({ where: { periodoId } });
  await tx.aprobacionPeriodo.deleteMany({ where: { periodoId } });
  await tx.periodoComision.update({
    where: { id: periodoId },
    data: {
      estado: EstadoPeriodo.BORRADOR, calculadoEn: null, configuracionUsada: Prisma.DbNull,
      enRevisionDesde: null, enviadoARevisionPor: null,
      cerradoEn: null, cerradoPor: null, pagadoEn: null, pagadoPor: null,
    },
  });
}
