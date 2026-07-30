-- AlterTable
ALTER TABLE "Usuario" ADD COLUMN     "codigo" VARCHAR(40);

-- AlterTable
ALTER TABLE "VendedoraComision" ADD COLUMN     "usuarioId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Usuario_codigo_key" ON "Usuario"("codigo");

-- CreateIndex
CREATE UNIQUE INDEX "VendedoraComision_usuarioId_key" ON "VendedoraComision"("usuarioId");

-- AddForeignKey
ALTER TABLE "VendedoraComision" ADD CONSTRAINT "VendedoraComision_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

