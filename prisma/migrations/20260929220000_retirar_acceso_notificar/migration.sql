-- Fase 2 de 2 (contract): la preferencia de aviso ya vive en "SilencioLinea"
-- (20260929210000) y ningún código lee ni escribe esta columna.
--
-- ORDEN AL DESPLEGAR: esta migración se aplica DESPUÉS de reiniciar el
-- servicio con el código nuevo, no antes. El proceso anterior tiene la columna
-- en su cliente de Prisma, que la pide en toda consulta sin `select`
-- explícito: borrarla con él vivo haría fallar esas consultas mientras compila
-- el nuevo. Ver crm-backend-arquitectura §4.
ALTER TABLE "AccesoLineaWhatsapp" DROP COLUMN "notificar";
