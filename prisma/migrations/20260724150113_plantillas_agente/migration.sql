-- CreateTable
CREATE TABLE "PlantillaAgente" (
    "id" TEXT NOT NULL,
    "usuarioId" TEXT NOT NULL,
    "titulo" TEXT NOT NULL,
    "atajo" TEXT,
    "contenido" TEXT NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlantillaAgente_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlantillaAgente_usuarioId_idx" ON "PlantillaAgente"("usuarioId");

-- CreateIndex
CREATE INDEX "PlantillaAgente_atajo_idx" ON "PlantillaAgente"("atajo");

-- AddForeignKey
ALTER TABLE "PlantillaAgente" ADD CONSTRAINT "PlantillaAgente_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "Usuario"("id") ON DELETE CASCADE ON UPDATE CASCADE;
