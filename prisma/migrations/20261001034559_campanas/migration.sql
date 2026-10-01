-- CreateEnum
CREATE TYPE "EstadoCampana" AS ENUM ('PROGRAMADA', 'ENVIANDO', 'PAUSADA', 'TERMINADA', 'CANCELADA');

-- CreateEnum
CREATE TYPE "EstadoDestinatario" AS ENUM ('PENDIENTE', 'ENVIANDO', 'ENVIADO', 'OMITIDO', 'FALLIDO');

-- CreateTable
CREATE TABLE "Campana" (
    "id" TEXT NOT NULL,
    "nombre" VARCHAR(120) NOT NULL,
    "lineaId" TEXT NOT NULL,
    "plantilla" VARCHAR(512) NOT NULL,
    "idioma" VARCHAR(20) NOT NULL,
    "variables" JSONB NOT NULL,
    "filtro" JSONB NOT NULL,
    "tarifaUsd" DECIMAL(8,4) NOT NULL,
    "estado" "EstadoCampana" NOT NULL,
    "motivoPausa" VARCHAR(300),
    "programadaPara" TIMESTAMP(3) NOT NULL,
    "creadaPorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "terminadaEn" TIMESTAMP(3),

    CONSTRAINT "Campana_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampanaDestinatario" (
    "id" TEXT NOT NULL,
    "campanaId" TEXT NOT NULL,
    "clienteId" TEXT NOT NULL,
    "orden" INTEGER NOT NULL,
    "estado" "EstadoDestinatario" NOT NULL DEFAULT 'PENDIENTE',
    "mensajeId" TEXT,
    "motivo" VARCHAR(300),
    "enviadoEn" TIMESTAMP(3),

    CONSTRAINT "CampanaDestinatario_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Campana_estado_programadaPara_idx" ON "Campana"("estado", "programadaPara");

-- CreateIndex
CREATE INDEX "Campana_createdAt_idx" ON "Campana"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CampanaDestinatario_mensajeId_key" ON "CampanaDestinatario"("mensajeId");

-- CreateIndex
CREATE INDEX "CampanaDestinatario_campanaId_estado_orden_idx" ON "CampanaDestinatario"("campanaId", "estado", "orden");

-- CreateIndex
CREATE UNIQUE INDEX "CampanaDestinatario_campanaId_clienteId_key" ON "CampanaDestinatario"("campanaId", "clienteId");

-- AddForeignKey
ALTER TABLE "Campana" ADD CONSTRAINT "Campana_lineaId_fkey" FOREIGN KEY ("lineaId") REFERENCES "LineaWhatsapp"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campana" ADD CONSTRAINT "Campana_creadaPorId_fkey" FOREIGN KEY ("creadaPorId") REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampanaDestinatario" ADD CONSTRAINT "CampanaDestinatario_campanaId_fkey" FOREIGN KEY ("campanaId") REFERENCES "Campana"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampanaDestinatario" ADD CONSTRAINT "CampanaDestinatario_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "Cliente"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampanaDestinatario" ADD CONSTRAINT "CampanaDestinatario_mensajeId_fkey" FOREIGN KEY ("mensajeId") REFERENCES "Mensaje"("id") ON DELETE SET NULL ON UPDATE CASCADE;
