-- AlterTable
ALTER TABLE "Conversacion" ADD COLUMN     "esperandoRespuesta" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Conversacion_esperandoRespuesta_updatedAt_idx" ON "Conversacion"("esperandoRespuesta", "updatedAt");

-- Backfill: sin esto las conversaciones que ya existen nacen todas en `false` y
-- la pestaña "Sin responder" aparece vacía el día del despliegue, escondiendo
-- justo a las pacientes que llevan más tiempo esperando.
--
-- Es el espejo exacto de `estaSinResponder()` del frontend: espera respuesta si
-- su ÚLTIMO mensaje es ENTRANTE, o es el acuse automático (que no cuenta como
-- respuesta de una persona). Una conversación sin ningún mensaje queda en
-- `false`, igual que devuelve esa función cuando no hay último mensaje.
--
-- `DISTINCT ON` resuelve "el último mensaje de cada conversación" en una sola
-- pasada; el índice (conversacionId, createdAt) ya existe y lo sostiene.
UPDATE "Conversacion" AS c
SET "esperandoRespuesta" = ultimo.espera
FROM (
  SELECT DISTINCT ON (m."conversacionId")
         m."conversacionId" AS conversacion_id,
         (m."direccion" = 'ENTRANTE' OR m."automatico" = true) AS espera
  FROM "Mensaje" m
  ORDER BY m."conversacionId", m."createdAt" DESC
) AS ultimo
WHERE c."id" = ultimo.conversacion_id;
