-- CreateTable
CREATE TABLE "AccesoMedicoAgenda" (
    "id" TEXT NOT NULL,
    "agendaMedicoId" INTEGER NOT NULL,
    "telefono" VARCHAR(20) NOT NULL,
    "nombreMedico" VARCHAR(200) NOT NULL,
    "autorizadoPorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccesoMedicoAgenda_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccesoMedicoAgenda_agendaMedicoId_key" ON "AccesoMedicoAgenda"("agendaMedicoId");

-- CreateIndex
CREATE UNIQUE INDEX "AccesoMedicoAgenda_telefono_key" ON "AccesoMedicoAgenda"("telefono");
