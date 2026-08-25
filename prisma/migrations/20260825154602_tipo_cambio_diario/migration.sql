-- CreateEnum
CREATE TYPE "FuenteTipoCambio" AS ENUM ('AUTOMATICO', 'MANUAL');

-- CreateTable
CREATE TABLE "TipoCambioDiario" (
    "fecha" DATE NOT NULL,
    "valor" DECIMAL(10,4) NOT NULL,
    "fuente" "FuenteTipoCambio" NOT NULL,
    "actualizadoPorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TipoCambioDiario_pkey" PRIMARY KEY ("fecha")
);

-- AddForeignKey
ALTER TABLE "TipoCambioDiario" ADD CONSTRAINT "TipoCambioDiario_actualizadoPorId_fkey" FOREIGN KEY ("actualizadoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

