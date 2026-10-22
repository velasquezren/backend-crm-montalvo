-- Los WhatsApp de caja que reciben el aviso de comprobante nuevo. Tabla nueva, aditiva.
CREATE TABLE "NumeroCaja" (
    "id" TEXT NOT NULL,
    "nombre" VARCHAR(80) NOT NULL,
    "telefono" VARCHAR(20) NOT NULL,
    "agregadoPorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NumeroCaja_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "NumeroCaja_telefono_key" ON "NumeroCaja"("telefono");
