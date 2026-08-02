-- Metas por mes: las que hoy son únicas por tipo pasan a tener dos capas.
--   · periodoId NULL → metas por defecto
--   · periodoId X    → metas propias de ese mes, que pisan a las de por defecto
--
-- Las filas que ya existen quedan con periodoId NULL, es decir se convierten en
-- las metas por defecto sin que administración tenga que hacer nada.
DROP INDEX "ObjetivoComision_tipo_key";

ALTER TABLE "ObjetivoComision" ADD COLUMN "periodoId" TEXT;

CREATE INDEX "ObjetivoComision_periodoId_idx" ON "ObjetivoComision"("periodoId");

CREATE UNIQUE INDEX "ObjetivoComision_tipo_periodoId_key" ON "ObjetivoComision"("tipo", "periodoId");

-- Borrar un periodo se lleva sus metas: no tiene sentido conservar la meta de un
-- mes que ya no existe.
ALTER TABLE "ObjetivoComision" ADD CONSTRAINT "ObjetivoComision_periodoId_fkey"
  FOREIGN KEY ("periodoId") REFERENCES "PeriodoComision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- En Postgres dos NULL no son iguales entre sí, así que el único de arriba NO
-- impide tener dos filas "por defecto" del mismo tipo — y entonces cuál gana
-- dependería del orden de lectura. Este índice parcial lo cierra. Prisma no
-- puede expresar un WHERE, así que vive solo aquí.
CREATE UNIQUE INDEX "ObjetivoComision_tipo_defecto_key"
  ON "ObjetivoComision"("tipo") WHERE "periodoId" IS NULL;
