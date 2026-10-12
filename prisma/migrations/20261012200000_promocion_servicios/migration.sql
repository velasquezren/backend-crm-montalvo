-- Servicios de una promoción, cada uno con su precio, y en el pago qué servicio
-- se cobró. Solo AÑADE: ninguna columna existente cambia.

-- CreateTable
CREATE TABLE "PromocionServicio" (
    "id" TEXT NOT NULL,
    "promocionId" TEXT NOT NULL,
    "nombre" VARCHAR(80) NOT NULL,
    "precioRegular" DECIMAL(10,2),
    "precioPromocional" DECIMAL(10,2) NOT NULL,
    "orden" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PromocionServicio_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "PagoPromocion" ADD COLUMN "concepto" VARCHAR(170),
ADD COLUMN "servicioId" TEXT;

-- CreateIndex
CREATE INDEX "PromocionServicio_promocionId_orden_idx" ON "PromocionServicio"("promocionId", "orden");

-- CreateIndex
CREATE INDEX "PagoPromocion_servicioId_idx" ON "PagoPromocion"("servicioId");

-- AddForeignKey
ALTER TABLE "PromocionServicio" ADD CONSTRAINT "PromocionServicio_promocionId_fkey" FOREIGN KEY ("promocionId") REFERENCES "Promocion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PagoPromocion" ADD CONSTRAINT "PagoPromocion_servicioId_fkey" FOREIGN KEY ("servicioId") REFERENCES "PromocionServicio"("id") ON DELETE SET NULL ON UPDATE CASCADE;
