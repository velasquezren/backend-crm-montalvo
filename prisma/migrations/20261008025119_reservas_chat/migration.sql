-- Reservas hechas por el Flow de WhatsApp, vistas desde el chat (conversaciones/reservas-chat.ts).
-- Solo AÑADE: un enum y una tabla nueva, sin tocar datos existentes.
-- CreateEnum
CREATE TYPE "EstadoReservaChat" AS ENUM ('SIN_PAGO', 'ESPERANDO_COMPROBANTE', 'COMPROBANTE_RECIBIDO', 'PAGO_REGISTRADO', 'REVISION');

-- CreateTable
CREATE TABLE "ReservaChat" (
    "id" TEXT NOT NULL,
    "conversacionId" TEXT NOT NULL,
    "reservaAgenda" INTEGER NOT NULL,
    "monto" DECIMAL(10,2),
    "qrClave" VARCHAR(120),
    "estado" "EstadoReservaChat" NOT NULL,
    "comprobanteMensajeId" TEXT,
    "qrMensajeId" TEXT,
    "comprobanteRecibidoEn" TIMESTAMP(3),
    "proximoIntento" TIMESTAMP(3),
    "intentos" INTEGER NOT NULL DEFAULT 0,
    "detalle" VARCHAR(300),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReservaChat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReservaChat_reservaAgenda_key" ON "ReservaChat"("reservaAgenda");

-- CreateIndex
CREATE UNIQUE INDEX "ReservaChat_comprobanteMensajeId_key" ON "ReservaChat"("comprobanteMensajeId");

-- CreateIndex
CREATE INDEX "ReservaChat_conversacionId_estado_idx" ON "ReservaChat"("conversacionId", "estado");

-- CreateIndex
CREATE INDEX "ReservaChat_estado_updatedAt_idx" ON "ReservaChat"("estado", "updatedAt");

-- AddForeignKey
ALTER TABLE "ReservaChat" ADD CONSTRAINT "ReservaChat_conversacionId_fkey" FOREIGN KEY ("conversacionId") REFERENCES "Conversacion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "ReservaChat_qrMensajeId_key" ON "ReservaChat"("qrMensajeId");
ALTER TABLE "ReservaChat" ADD CONSTRAINT "ReservaChat_qrMensajeId_fkey" FOREIGN KEY ("qrMensajeId") REFERENCES "Mensaje"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReservaChat" ADD CONSTRAINT "ReservaChat_comprobanteMensajeId_fkey" FOREIGN KEY ("comprobanteMensajeId") REFERENCES "Mensaje"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReservaChat" ADD CONSTRAINT "ReservaChat_monto_valido" CHECK ("monto" IS NULL OR "monto" > 0), ADD CONSTRAINT "ReservaChat_intentos_validos" CHECK ("intentos" >= 0);
