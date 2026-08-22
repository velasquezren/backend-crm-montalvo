-- AlterTable
ALTER TABLE "ResultadoComision" ADD COLUMN     "comisionTipoARA" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "nivelTipoARA" INTEGER;

-- CreateTable
CREATE TABLE "NivelTipoARA" (
    "id" TEXT NOT NULL,
    "nivel" INTEGER NOT NULL,
    "montoDesde" DECIMAL(12,2) NOT NULL,
    "montoHasta" DECIMAL(12,2) NOT NULL,
    "pctEmpresa" DECIMAL(6,3) NOT NULL,
    "pctPropio" DECIMAL(6,3) NOT NULL,

    CONSTRAINT "NivelTipoARA_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NivelTipoARA_nivel_key" ON "NivelTipoARA"("nivel");
