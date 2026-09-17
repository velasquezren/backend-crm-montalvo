-- Idempotencia del envío de mensajes.
--
-- El backend persiste el mensaje y dispara el envío a Meta ANTES de responder
-- el POST, así que una respuesta HTTP perdida no significa que el mensaje no
-- saliera. Sin una clave estable de la INTENCIÓN de envío, reintentar creaba
-- una segunda fila y un segundo despacho: dos WhatsApp reales a la paciente.
--
-- La columna es NULLABLE y no se rellena hacia atrás: los históricos y los
-- clientes viejos que no la manden siguen funcionando. El índice único de
-- PostgreSQL ignora los NULL, así que conviven sin chocar entre sí.
--
-- La garantía es este índice, no un `if` en la aplicación: dos peticiones
-- concurrentes con el mismo valor no pueden crear dos filas ni aunque lean a
-- la vez. El servicio captura el P2002 y devuelve la fila existente.
ALTER TABLE "Mensaje" ADD COLUMN "clientMessageId" VARCHAR(64);

CREATE UNIQUE INDEX "Mensaje_clientMessageId_key" ON "Mensaje"("clientMessageId");
