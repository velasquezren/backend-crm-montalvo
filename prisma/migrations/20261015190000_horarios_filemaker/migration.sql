-- CreateTable
CREATE TABLE "HorarioFilemaker" (
    "codigo" TEXT NOT NULL,
    "registroId" TEXT NOT NULL,
    "medicoAgendaId" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL,
    "huella" TEXT NOT NULL,
    "datos" JSONB NOT NULL,
    "pendiente" BOOLEAN NOT NULL DEFAULT true,
    "sincronizadoEn" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HorarioFilemaker_pkey" PRIMARY KEY ("codigo")
);

-- CreateIndex
CREATE UNIQUE INDEX "HorarioFilemaker_registroId_key" ON "HorarioFilemaker"("registroId");

-- CreateIndex
CREATE UNIQUE INDEX "HorarioFilemaker_medicoAgendaId_key" ON "HorarioFilemaker"("medicoAgendaId");

-- CreateIndex
CREATE INDEX "HorarioFilemaker_pendiente_updatedAt_idx" ON "HorarioFilemaker"("pendiente", "updatedAt");
