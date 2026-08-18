-- El id del ANUNCIO de Click-to-WhatsApp necesita columna propia.
--
-- Estaba yendo a `metaLeadId`, que es UNIQUE porque es la clave de idempotencia
-- de Lead Ads (un `leadgen_id` por persona). Un anuncio, en cambio, lo clican
-- muchas pacientes: de la segunda en adelante el INSERT violaba el índice único
-- y se perdía el lead.
--
-- Sin UNIQUE, y con índice para poder contar cuántos leads trajo cada anuncio.

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "anuncioId" VARCHAR(64);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Lead_anuncioId_idx" ON "Lead"("anuncioId");

-- Rescata la atribución de los leads de campaña que sí llegaron a guardarse
-- (los primeros de cada anuncio) y libera `metaLeadId`, que en ellos nunca fue
-- un leadgen_id. Sin esto, el índice único sigue ocupado por ids de anuncio y
-- el problema persiste para las siguientes pacientes de esas mismas campañas.
UPDATE "Lead"
SET "anuncioId" = "metaLeadId",
    "metaLeadId" = NULL
WHERE "metaLeadId" IS NOT NULL
  AND "origen" IN ('FACEBOOK_LEAD_AD', 'INSTAGRAM_LEAD_AD')
  AND EXISTS (
    -- Solo los que entraron por Click-to-WhatsApp: esos dejaron la huella de la
    -- campaña en `Cliente.datosExtra`. Los de Lead Ads de verdad no la tienen y
    -- hay que dejarles su `metaLeadId` intacto.
    SELECT 1 FROM "Cliente" c
    WHERE c.id = "Lead"."clienteId"
      AND c."datosExtra" -> 'campanaOrigen' ->> 'anuncioId' = "Lead"."metaLeadId"
  );
