-- DropIndex
DROP INDEX "Conversacion_clienteId_idx";

-- CreateIndex
CREATE UNIQUE INDEX "Conversacion_clienteId_key" ON "Conversacion"("clienteId");

