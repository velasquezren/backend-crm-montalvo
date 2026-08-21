-- DropForeignKey
ALTER TABLE "Comision" DROP CONSTRAINT IF EXISTS "Comision_agenteId_fkey";
ALTER TABLE "Comision" DROP CONSTRAINT IF EXISTS "Comision_ventaId_fkey";

-- DropTable
DROP TABLE IF EXISTS "Comision";

-- DropEnum
DROP TYPE IF EXISTS "EstadoComision";
