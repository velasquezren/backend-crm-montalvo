-- CreateEnum
CREATE TYPE "EstadoLead" AS ENUM ('NUEVO', 'CONTACTADO', 'CONVERTIDO', 'PERDIDO');

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "estado" "EstadoLead" NOT NULL DEFAULT 'NUEVO';

-- CreateIndex
CREATE INDEX "Lead_estado_idx" ON "Lead"("estado");
