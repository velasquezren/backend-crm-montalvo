-- CreateEnum
CREATE TYPE "FrecuenciaRepeticion" AS ENUM ('SEMANAL', 'QUINCENAL', 'MENSUAL');

-- AlterTable
ALTER TABLE "Actividad" ADD COLUMN     "frecuenciaSerie" "FrecuenciaRepeticion",
ADD COLUMN     "serieId" TEXT;

-- CreateIndex
CREATE INDEX "Actividad_serieId_fechaProgramada_idx" ON "Actividad"("serieId", "fechaProgramada");
