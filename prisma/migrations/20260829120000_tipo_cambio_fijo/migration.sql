-- CreateEnum
CREATE TYPE "ModoTipoCambio" AS ENUM ('FIJO', 'AUTOMATICO');

-- CreateTable
CREATE TABLE "ConfiguracionTipoCambio" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "modo" "ModoTipoCambio" NOT NULL DEFAULT 'FIJO',
    "valorFijo" DECIMAL(10,4) NOT NULL DEFAULT 6.97,
    "actualizadoPorId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConfiguracionTipoCambio_pkey" PRIMARY KEY ("id")
);

-- Fila única de verdad: sin esto nada impide un segundo criterio vigente, y
-- cuál gana quedaría al orden de lectura.
ALTER TABLE "ConfiguracionTipoCambio" ADD CONSTRAINT "ConfiguracionTipoCambio_fila_unica" CHECK ("id" = 1);

-- Se siembra en FIJO a 6,97, que es como opera la clínica hoy y con lo que se
-- liquidaron los seis periodos de 2026. Arrancar en AUTOMATICO haría que el
-- selector Bs/$us empezara a convertir con el TCO del día (11,92 en agosto),
-- un 71 % por encima de cualquier cifra realmente pagada.
INSERT INTO "ConfiguracionTipoCambio" ("id", "modo", "valorFijo", "updatedAt")
VALUES (1, 'FIJO', 6.97, CURRENT_TIMESTAMP);
