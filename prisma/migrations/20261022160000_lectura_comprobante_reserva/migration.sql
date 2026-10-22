-- La lectura automática del comprobante de una cita (como en PagoPromocion).
-- Aditiva y nullable: las filas existentes no cambian.
ALTER TABLE "ReservaChat" ADD COLUMN "lecturaComprobante" JSONB;
