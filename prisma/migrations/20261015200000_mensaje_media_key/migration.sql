-- Cuota de Mi Memoria (descuenta lo enviado) y borrado de recursos: buscan el mensaje por mediaKey.
CREATE INDEX "Mensaje_mediaKey_idx" ON "Mensaje"("mediaKey");
