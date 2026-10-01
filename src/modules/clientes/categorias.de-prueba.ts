import { AuditService } from '../../common/audit/audit.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { TipoCambioService } from '../tipo-cambio/tipo-cambio.service';
import { CategoriaPacienteService } from './categoria-paciente.service';

/**
 * El `CategoriaPacienteService` real, armado a mano para las suites que
 * construyen `ClientesService` sin Nest. Real y no un doble: recalcular la
 * categoría es SQL, y una suite que guarda ventas tiene que ver la categoría
 * que vería producción. Los `*.de-prueba.ts` quedan fuera del build.
 */
export function categoriasDePrueba(prisma: PrismaService): CategoriaPacienteService {
  const audit = new AuditService(prisma);
  return new CategoriaPacienteService(prisma, audit, new TipoCambioService(prisma, audit));
}
