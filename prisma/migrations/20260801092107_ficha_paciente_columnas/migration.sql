-- La ficha del paciente pasa de JSON a columnas propias: el listado las trae
-- sin coste, la ficha abre sin peticiones extra y se pueden agregar en SQL.
ALTER TABLE "Cliente"
  ADD COLUMN "fechaNacimiento" DATE,
  ADD COLUMN "sexo"            VARCHAR(1),
  ADD COLUMN "ocupacion"       VARCHAR(80),
  ADD COLUMN "ci"              VARCHAR(40),
  ADD COLUMN "ciLugar"         VARCHAR(30),
  ADD COLUMN "estadoCivil"     VARCHAR(25),
  ADD COLUMN "direccion"       VARCHAR(200),
  ADD COLUMN "nacionalidad"    VARCHAR(50),
  ADD COLUMN "telefonoFijo"    VARCHAR(30),
  ADD COLUMN "nit"             VARCHAR(45),
  ADD COLUMN "saldoTotal"      DECIMAL(12,2);

-- Relleno desde el volcado que ya estaba guardado. NULLIF descarta las cadenas
-- vacías que FileMaker exporta para los campos sin dato, para no llenar la
-- tabla de '' que despues habria que filtrar en cada consulta.
UPDATE "Cliente" SET
  -- F_Naci viene como serial de Excel (dias desde 1899-12-30). Se guarda la
  -- fecha y NO la edad: la edad del volcado esta congelada en el dia de la
  -- exportacion y hoy se desvia hasta 18 anios.
  "fechaNacimiento" = CASE
      WHEN "datosExtra"->>'F_Naci' ~ '^[0-9]+$'
       AND ("datosExtra"->>'F_Naci')::int BETWEEN 1 AND 60000
      THEN DATE '1899-12-30' + (("datosExtra"->>'F_Naci')::int)
    END,
  "sexo"         = NULLIF(LEFT(TRIM("datosExtra"->>'Sexo'), 1), ''),
  "ocupacion"    = NULLIF(TRIM("datosExtra"->>'Profesion'), ''),
  "ci"           = NULLIF(TRIM("datosExtra"->>'CI.Pac'), ''),
  "ciLugar"      = NULLIF(TRIM("datosExtra"->>'CI.Lug.Pac'), ''),
  "estadoCivil"  = NULLIF(TRIM("datosExtra"->>'E_Civil'), ''),
  "direccion"    = NULLIF(LEFT(TRIM("datosExtra"->>'Direccion'), 200), ''),
  "nacionalidad" = NULLIF(TRIM("datosExtra"->>'Nacionalidad'), ''),
  "telefonoFijo" = NULLIF(TRIM("datosExtra"->>'Telef.Dom'), ''),
  "nit"          = NULLIF(TRIM("datosExtra"->>'NIT'), ''),
  "saldoTotal"   = CASE
      WHEN "datosExtra"->>'SaldoTotal' ~ '^-?[0-9]+(\.[0-9]+)?$'
      THEN ("datosExtra"->>'SaldoTotal')::decimal
    END
WHERE "datosExtra" IS NOT NULL;

-- Indices para las preguntas de negocio que se van a hacer de verdad:
-- cumpleanios del mes, segmentacion por ocupacion y cartera pendiente.
CREATE INDEX "Cliente_fechaNacimiento_idx" ON "Cliente"("fechaNacimiento");
CREATE INDEX "Cliente_ocupacion_idx"       ON "Cliente"("ocupacion");
CREATE INDEX "Cliente_saldoTotal_idx"      ON "Cliente"("saldoTotal") WHERE "saldoTotal" > 0;
