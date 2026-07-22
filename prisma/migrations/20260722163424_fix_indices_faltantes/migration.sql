-- CreateIndex
CREATE INDEX "Comision_agenteId_estado_idx" ON "Comision"("agenteId", "estado");

-- CreateIndex
CREATE INDEX "Conversacion_agenteId_updatedAt_idx" ON "Conversacion"("agenteId", "updatedAt");

-- CreateIndex
CREATE INDEX "Lead_origen_estado_idx" ON "Lead"("origen", "estado");

-- CreateIndex
CREATE INDEX "Lead_agenteId_estado_idx" ON "Lead"("agenteId", "estado");

-- CreateIndex
CREATE INDEX "Venta_agenteId_estado_idx" ON "Venta"("agenteId", "estado");
