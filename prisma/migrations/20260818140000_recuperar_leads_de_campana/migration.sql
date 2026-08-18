-- Recupera los leads que el bug de `metaLeadId` tiró a la basura.
--
-- La migración anterior (20260818020000) liberó la clave única y le devolvió su
-- `anuncioId` al ÚNICO lead que sí llegó a guardarse. Pero no recupera a las
-- demás pacientes: de la segunda en adelante, el INSERT reventaba con P2002 y
-- el lead sencillamente no existía.
--
-- Medido en producción antes de escribir esto:
--   34  pacientes llegaron por campaña (todas de UN mismo anuncio)
--    3  tenían lead
--   31  no tenían ninguno  ← se recuperan aquí
--   31  de esas 31 tienen conversación de WhatsApp abierta
--    0  han comprado todavía
--   Llegaron entre el 15 y el 18 de agosto de 2026.
--
-- O sea: prospectos vivos, con la agente conversando, invisibles en Leads &
-- Prospectos. La campaña mostraba 3 leads en vez de 34, y esas 31 personas no
-- avanzaban por ningún embudo porque para el sistema no existían.
--
-- Los campos se derivan igual que lo hace `procesarEntrante` para un contacto
-- nuevo de campaña, para que un lead recuperado sea indistinguible de uno que
-- entre a partir de ahora:
--   · origen    — INSTAGRAM si la URL de origen lo dice, si no FACEBOOK
--                 (misma regla que `esInstagram` en conversaciones.service.ts)
--   · anuncioId — de la huella que quedó en `Cliente.datosExtra.campanaOrigen`
--   · agenteId  — el de la paciente, que es lo que usa el código
--   · estado    — NUEVO: nadie los ha movido por el embudo todavía
--   · createdAt — cuándo llegó la PACIENTE, no cuándo corre esta migración;
--                 fecharlos hoy falsearía el tiempo de respuesta de la campaña
--
-- Es idempotente: el NOT EXISTS impide duplicar si se reaplica, y solo mira
-- clientes con huella de campaña, así que no inventa leads de nadie más.

INSERT INTO "Lead" (id, "clienteId", origen, estado, "anuncioId", "agenteId", "createdAt")
SELECT
  gen_random_uuid(),
  c.id,
  CASE
    WHEN lower(COALESCE(c."datosExtra" -> 'campanaOrigen' ->> 'origenUrl', '')) LIKE '%instagram%'
      THEN 'INSTAGRAM_LEAD_AD'::"OrigenLead"
    ELSE 'FACEBOOK_LEAD_AD'::"OrigenLead"
  END,
  'NUEVO'::"EstadoLead",
  c."datosExtra" -> 'campanaOrigen' ->> 'anuncioId',
  c."agenteId",
  c."createdAt"
FROM "Cliente" c
WHERE c."datosExtra" -> 'campanaOrigen' IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "Lead" l WHERE l."clienteId" = c.id
  );
