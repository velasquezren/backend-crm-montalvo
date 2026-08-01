-- Ultimos datos utiles que quedaban enterrados en el volcado de FileMaker.
-- Con esto ya no hay informacion de negocio dentro del JSON: lo que queda ahi
-- son contadores internos del sistema antiguo, sin uso en el CRM.
ALTER TABLE "Cliente"
  ADD COLUMN "empresaTrabajo"  VARCHAR(120),
  ADD COLUMN "contactoRef"     VARCHAR(120),
  ADD COLUMN "telefonoRef"     VARCHAR(30),
  ADD COLUMN "telefonoOficina" VARCHAR(30),
  ADD COLUMN "visitasPrevias"  INTEGER;

UPDATE "Cliente" SET
  "empresaTrabajo"  = NULLIF(LEFT(TRIM("datosExtra"->>'EmpTrab'), 120), ''),
  "contactoRef"     = NULLIF(LEFT(TRIM("datosExtra"->>'Con.Nombre'), 120), ''),
  "telefonoRef"     = NULLIF(LEFT(TRIM("datosExtra"->>'Con.Tel'), 30), ''),
  "telefonoOficina" = NULLIF(LEFT(TRIM("datosExtra"->>'Telf.Ofic.'), 30), ''),
  -- Movimientos es el numero de visitas acumuladas: el mejor indicador de
  -- recurrencia del volcado. 14.908 de 15.297 pacientes lo traen.
  "visitasPrevias"  = CASE
      WHEN "datosExtra"->>'Movimientos' ~ '^[0-9]+$'
      THEN LEAST(("datosExtra"->>'Movimientos')::bigint, 2147483647)::int
    END
WHERE "datosExtra" IS NOT NULL;

-- Segmentar por recurrencia es una consulta que se va a hacer de verdad.
CREATE INDEX "Cliente_visitasPrevias_idx" ON "Cliente"("visitasPrevias" DESC NULLS LAST);
