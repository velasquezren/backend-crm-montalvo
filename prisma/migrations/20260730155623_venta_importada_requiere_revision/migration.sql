-- AlterTable
ALTER TABLE "VentaImportada" ADD COLUMN     "requiereRevision" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "VentaImportada_periodoId_requiereRevision_idx" ON "VentaImportada"("periodoId", "requiereRevision");
