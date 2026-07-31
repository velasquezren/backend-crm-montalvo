-- El PAC del paciente pasa de estar enterrado en `datosExtra` (JSON) a columna
-- indexada: con esto el historial de servicios es un join y no un escaneo
-- secuencial de 15.000 filas por consulta.
ALTER TABLE "Cliente" ADD COLUMN "pac" VARCHAR(20);

-- Relleno desde lo que la importación de FileMaker ya habia guardado. En
-- MAYUSCULAS porque el maestro de pacientes exporta `Pac1897` y el de ventas
-- `PAC50660`: sin normalizar, las mismas personas no cruzarian.
UPDATE "Cliente"
SET "pac" = UPPER("datosExtra"->>'pk')
WHERE "datosExtra"->>'pk' IS NOT NULL;

CREATE UNIQUE INDEX "Cliente_pac_key" ON "Cliente"("pac");
