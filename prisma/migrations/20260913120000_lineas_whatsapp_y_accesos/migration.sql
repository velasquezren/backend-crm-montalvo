-- AlterEnum
ALTER TYPE "Rol" ADD VALUE 'RECEPCION';

-- DropIndex
DROP INDEX "Conversacion_clienteId_key";

-- AlterTable
ALTER TABLE "Conversacion" ADD COLUMN     "lineaId" TEXT NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001';

-- CreateTable
CREATE TABLE "LineaWhatsapp" (
    "id" TEXT NOT NULL,
    "nombre" VARCHAR(120) NOT NULL,
    "telefono" VARCHAR(20),
    "phoneNumberId" VARCHAR(80),
    "wabaId" VARCHAR(80),
    "tokenEnv" VARCHAR(100) NOT NULL,
    "activa" BOOLEAN NOT NULL DEFAULT false,
    "comercial" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "LineaWhatsapp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccesoLineaWhatsapp" (
    "usuarioId" TEXT NOT NULL,
    "lineaId" TEXT NOT NULL,

    CONSTRAINT "AccesoLineaWhatsapp_pkey" PRIMARY KEY ("usuarioId","lineaId")
);

-- CreateIndex
CREATE UNIQUE INDEX "LineaWhatsapp_telefono_key" ON "LineaWhatsapp"("telefono");

-- CreateIndex
CREATE UNIQUE INDEX "LineaWhatsapp_phoneNumberId_key" ON "LineaWhatsapp"("phoneNumberId");

-- CreateIndex
CREATE INDEX "AccesoLineaWhatsapp_lineaId_idx" ON "AccesoLineaWhatsapp"("lineaId");

-- CreateIndex
CREATE INDEX "Conversacion_lineaId_updatedAt_idx" ON "Conversacion"("lineaId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Conversacion_clienteId_lineaId_key" ON "Conversacion"("clienteId", "lineaId");

-- La línea anterior conserva historial y credenciales del servidor.
INSERT INTO "LineaWhatsapp" ("id", "nombre", "telefono", "tokenEnv", "activa", "comercial") VALUES
('00000000-0000-4000-8000-000000000001', 'Ventas y publicidad Montalvo', NULL, 'WHATSAPP_TOKEN', true, true),
('00000000-0000-4000-8000-000000000002', 'Laboratorio CLIMON', '+59162140323', 'WHATSAPP_CLIMON_TOKEN', false, false),
('00000000-0000-4000-8000-000000000003', 'Recepción Clínica Montalvo Corporativo', '+59175031306', 'WHATSAPP_RECEPCION_TOKEN', false, false),
('00000000-0000-4000-8000-000000000004', 'Centro Médico Montalvo', '+59176065490', 'WHATSAPP_CENTRO_TOKEN', false, false);

-- Solo las cuentas comerciales existentes reciben el acceso histórico.
-- Las cuentas nuevas requieren asignación explícita de líneas.
INSERT INTO "AccesoLineaWhatsapp" ("usuarioId", "lineaId")
SELECT "id", '00000000-0000-4000-8000-000000000001' FROM "Usuario" WHERE "rol" = 'AGENTE';

-- AddForeignKey
ALTER TABLE "AccesoLineaWhatsapp" ADD CONSTRAINT "AccesoLineaWhatsapp_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "Usuario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccesoLineaWhatsapp" ADD CONSTRAINT "AccesoLineaWhatsapp_lineaId_fkey" FOREIGN KEY ("lineaId") REFERENCES "LineaWhatsapp"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversacion" ADD CONSTRAINT "Conversacion_lineaId_fkey" FOREIGN KEY ("lineaId") REFERENCES "LineaWhatsapp"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
