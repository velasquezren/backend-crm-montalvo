-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "motivoPerdida" VARCHAR(200);

-- AlterTable
ALTER TABLE "Venta" ADD COLUMN     "leadId" TEXT,
ADD COLUMN     "motivoPerdida" VARCHAR(200);

-- CreateIndex
CREATE INDEX "Venta_leadId_idx" ON "Venta"("leadId");

-- AddForeignKey
ALTER TABLE "Venta" ADD CONSTRAINT "Venta_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
