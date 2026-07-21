-- DropIndex
DROP INDEX "Mensaje_conversacionId_idx";

-- AlterTable
ALTER TABLE "Usuario" ADD COLUMN     "foto" TEXT;

-- CreateIndex
CREATE INDEX "Cliente_agenteId_idx" ON "Cliente"("agenteId");

-- CreateIndex
CREATE INDEX "Conversacion_agenteId_idx" ON "Conversacion"("agenteId");

-- CreateIndex
CREATE INDEX "Conversacion_updatedAt_idx" ON "Conversacion"("updatedAt");

-- CreateIndex
CREATE INDEX "Lead_agenteId_idx" ON "Lead"("agenteId");

-- CreateIndex
CREATE INDEX "Mensaje_conversacionId_createdAt_idx" ON "Mensaje"("conversacionId", "createdAt");

-- CreateIndex
CREATE INDEX "Venta_estado_idx" ON "Venta"("estado");

-- CreateIndex
CREATE INDEX "Venta_createdAt_idx" ON "Venta"("createdAt");
