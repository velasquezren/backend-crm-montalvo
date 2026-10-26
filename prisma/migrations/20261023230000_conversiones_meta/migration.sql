-- Outbox del aviso de ventas a Meta (Conversions API para Business Messaging).
-- Aditiva: tabla y enum nuevos; nada se escribe en ella mientras META_CONVERSIONES
-- no esté encendida. Ver docs/conversiones-meta.md.
-- CreateEnum
CREATE TYPE "EstadoConversionMeta" AS ENUM ('PENDIENTE', 'ENVIADO', 'DESCARTADO', 'FALLIDO', 'INCIERTO');

-- CreateTable
CREATE TABLE "ConversionMeta" (
    "id" TEXT NOT NULL,
    "ventaId" TEXT NOT NULL,
    "estado" "EstadoConversionMeta" NOT NULL DEFAULT 'PENDIENTE',
    "ocurridoEn" TIMESTAMP(3) NOT NULL,
    "proximoIntento" TIMESTAMP(3) NOT NULL,
    "intentos" INTEGER NOT NULL DEFAULT 0,
    "motivo" VARCHAR(300),
    "fbtraceId" VARCHAR(64),
    "enviadoEn" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversionMeta_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConversionMeta_ventaId_key" ON "ConversionMeta"("ventaId");

-- CreateIndex
CREATE INDEX "ConversionMeta_estado_proximoIntento_idx" ON "ConversionMeta"("estado", "proximoIntento");

-- AddForeignKey
ALTER TABLE "ConversionMeta" ADD CONSTRAINT "ConversionMeta_ventaId_fkey" FOREIGN KEY ("ventaId") REFERENCES "Venta"("id") ON DELETE CASCADE ON UPDATE CASCADE;

