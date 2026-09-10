-- F06 entrega 2 — distinguir "no salió" de "no se sabe si salió".
--
-- INCIERTO es el estado de un mensaje cuyo POST hacia Meta se cortó (red caída,
-- corte por tiempo, 5xx) sin saber si llegó. Antes caía en FALLIDO, y esa
-- afirmación llevaba a que una agente lo reenviara a mano y la paciente lo
-- recibiera dos veces.
--
-- AlterEnum
ALTER TYPE "EstadoMensaje" ADD VALUE IF NOT EXISTS 'INCIERTO';

-- AlterTable
-- `intentosEnvio` solo crece cuando CONSTA que no salió; un INCIERTO no se
-- reintenta, así que no cuenta. `proximoIntento` es null en casi todas las
-- filas: solo un FALLIDO con intentos por delante lleva fecha.
ALTER TABLE "Mensaje" ADD COLUMN "intentosEnvio" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Mensaje" ADD COLUMN "proximoIntento" TIMESTAMP(3);

-- CreateIndex
-- Lo usa solo el barrido de reintentos, que pregunta por `proximoIntento`
-- vencido. Sobre una columna casi siempre nula apenas pesa, y evita recorrer
-- la tabla de mensajes entera cada minuto.
CREATE INDEX "Mensaje_proximoIntento_idx" ON "Mensaje"("proximoIntento");
