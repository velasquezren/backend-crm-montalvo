/*
  Warnings:

  - You are about to drop the column `promociones` on the `MenuAtencion` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "EstadoPagoPromocion" AS ENUM ('PENDIENTE', 'COMPROBANTE_ENVIADO', 'CONFIRMADO', 'ANULADO');

-- AlterEnum
-- BEFORE: el orden del enum es la prioridad de «Atención» (ORDEN_ATENCION). Un
-- comprobante por verificar va antes que una respuesta para revisar.
ALTER TYPE "MotivoAtencion" ADD VALUE 'COMPROBANTE_PAGO' BEFORE 'REVISION';

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "promocionId" TEXT;

-- AlterTable
-- La opción «Promociones» del menú lee ahora las promociones publicadas del CRM
-- (una sola fuente). El editor de esa lista escrita a mano nunca llegó a
-- producción; comprobar que esté vacía antes de desplegar (docs/pagos-promocion.md).
ALTER TABLE "MenuAtencion" DROP COLUMN "promociones";

-- CreateTable
CREATE TABLE "CobroLinea" (
    "lineaId" TEXT NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT false,
    "banco" VARCHAR(60) NOT NULL,
    "titular" VARCHAR(120) NOT NULL,
    "instrucciones" VARCHAR(500),
    "venceEl" DATE,
    "imagenId" VARCHAR(40),
    "imagenClave" VARCHAR(200),
    "imagenMime" VARCHAR(40),
    "imagenBytes" INTEGER,
    "actualizadoEn" TIMESTAMP(3) NOT NULL,
    "actualizadoPorId" TEXT,

    CONSTRAINT "CobroLinea_pkey" PRIMARY KEY ("lineaId")
);

-- CreateTable
CREATE TABLE "PagoPromocion" (
    "id" TEXT NOT NULL,
    "conversacionId" TEXT NOT NULL,
    "lineaId" TEXT NOT NULL,
    "promocionId" TEXT NOT NULL,
    "monto" DECIMAL(10,2) NOT NULL,
    "estado" "EstadoPagoPromocion" NOT NULL DEFAULT 'PENDIENTE',
    "comprobanteMensajeId" TEXT,
    "motivoRechazo" VARCHAR(300),
    "ventaId" TEXT,
    "cerradoPorId" TEXT,
    "cerradoEn" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PagoPromocion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PagoPromocion_monto_check" CHECK ("monto" > 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "CobroLinea_imagenId_key" ON "CobroLinea"("imagenId");

-- CreateIndex
CREATE UNIQUE INDEX "PagoPromocion_ventaId_key" ON "PagoPromocion"("ventaId");

-- CreateIndex
CREATE INDEX "PagoPromocion_conversacionId_estado_idx" ON "PagoPromocion"("conversacionId", "estado");

-- CreateIndex
CREATE INDEX "PagoPromocion_promocionId_estado_idx" ON "PagoPromocion"("promocionId", "estado");

-- CreateIndex
CREATE INDEX "PagoPromocion_lineaId_idx" ON "PagoPromocion"("lineaId");

-- CreateIndex
CREATE INDEX "PagoPromocion_cerradoPorId_idx" ON "PagoPromocion"("cerradoPorId");

-- CreateIndex
CREATE INDEX "Lead_promocionId_idx" ON "Lead"("promocionId");

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_promocionId_fkey" FOREIGN KEY ("promocionId") REFERENCES "Promocion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CobroLinea" ADD CONSTRAINT "CobroLinea_lineaId_fkey" FOREIGN KEY ("lineaId") REFERENCES "LineaWhatsapp"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CobroLinea" ADD CONSTRAINT "CobroLinea_actualizadoPorId_fkey" FOREIGN KEY ("actualizadoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PagoPromocion" ADD CONSTRAINT "PagoPromocion_conversacionId_fkey" FOREIGN KEY ("conversacionId") REFERENCES "Conversacion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PagoPromocion" ADD CONSTRAINT "PagoPromocion_lineaId_fkey" FOREIGN KEY ("lineaId") REFERENCES "LineaWhatsapp"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PagoPromocion" ADD CONSTRAINT "PagoPromocion_promocionId_fkey" FOREIGN KEY ("promocionId") REFERENCES "Promocion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PagoPromocion" ADD CONSTRAINT "PagoPromocion_ventaId_fkey" FOREIGN KEY ("ventaId") REFERENCES "Venta"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PagoPromocion" ADD CONSTRAINT "PagoPromocion_cerradoPorId_fkey" FOREIGN KEY ("cerradoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;
