-- Idempotencia del registro de ventas: la clave la genera el navegador por
-- cada intención de registrar. Aditiva y nula: las ventas existentes no cambian.
ALTER TABLE "Venta" ADD COLUMN "clientRequestId" VARCHAR(64);

CREATE UNIQUE INDEX "Venta_clientRequestId_key" ON "Venta"("clientRequestId");
