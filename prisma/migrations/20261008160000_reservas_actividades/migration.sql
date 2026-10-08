ALTER TYPE "EstadoReservaChat" ADD VALUE 'GESTIONADA';
ALTER TABLE "Actividad"
  ALTER COLUMN "clienteId" DROP NOT NULL,
  ALTER COLUMN "agenteId" DROP NOT NULL,
  ADD COLUMN "reservaAgenda" INTEGER,
  ADD COLUMN "reservaEstado" VARCHAR(32),
  ADD COLUMN "reservaFecha" TIMESTAMP(3),
  ADD COLUMN "reservaMedico" VARCHAR(160),
  ADD COLUMN "reservaPaciente" VARCHAR(120),
  ADD COLUMN "reservaRevisadaEn" TIMESTAMP(3),
  ADD COLUMN "conversacionId" TEXT,
  ADD COLUMN "reservaDeChat" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "avisoEnProcesoHasta" TIMESTAMP(3);
CREATE UNIQUE INDEX "Actividad_reservaAgenda_key" ON "Actividad"("reservaAgenda");
CREATE INDEX "Actividad_reservaRevisadaEn_id_idx" ON "Actividad"("reservaRevisadaEn", "id");
CREATE INDEX "Actividad_conversacionId_idx" ON "Actividad"("conversacionId");
ALTER TABLE "Actividad" ADD CONSTRAINT "Actividad_conversacionId_fkey"
  FOREIGN KEY ("conversacionId") REFERENCES "Conversacion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Actividad" ADD CONSTRAINT "Actividad_origen_valido" CHECK (
  ("reservaAgenda" IS NULL AND "clienteId" IS NOT NULL AND "agenteId" IS NOT NULL AND "reservaDeChat" = false AND "conversacionId" IS NULL)
  OR ("reservaAgenda" IS NOT NULL AND "reservaAgenda" > 0 AND "agenteId" IS NULL AND "serieId" IS NULL AND "leadId" IS NULL)
);
