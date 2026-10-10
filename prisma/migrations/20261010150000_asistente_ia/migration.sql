-- El asistente de IA (docs/asistente-ia.md): configuración por línea,
-- sugerencias, registro de turnos y la lectura de comprobantes. Todo aditivo.

-- CreateEnum
CREATE TYPE "ModoAsistente" AS ENUM ('APAGADO', 'SUGERIR', 'RESPONDER');

-- CreateEnum
CREATE TYPE "EstadoSugerencia" AS ENUM ('PENDIENTE', 'USADA', 'DESCARTADA', 'SUPERADA');

-- CreateEnum
CREATE TYPE "ResultadoTurnoAsistente" AS ENUM ('SUGIRIO', 'RESPONDIO', 'DERIVO', 'OMITIDO', 'FALLO');

-- AlterEnum
-- AFTER: Postgres ordena un enum por su declaración y ese orden ES la prioridad
-- de la pestaña «Atención». El `ADD VALUE` que genera Prisma los pondría al
-- final, detrás de REVISION. Ver 20261005170920_menu_atencion.
ALTER TYPE "MotivoAtencion" ADD VALUE 'POSIBLE_URGENCIA' AFTER 'EMERGENCIA';
ALTER TYPE "MotivoAtencion" ADD VALUE 'DERIVADA_ASISTENTE' AFTER 'SOLICITUD_CITA';

-- AlterTable
ALTER TABLE "PagoPromocion" ADD COLUMN     "lecturaComprobante" JSONB,
ADD COLUMN     "lecturaIntentos" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Mensaje" ADD COLUMN     "asistente" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "AsistenteLinea" (
    "lineaId" TEXT NOT NULL,
    "modo" "ModoAsistente" NOT NULL DEFAULT 'APAGADO',
    "conocimiento" VARCHAR(8000) NOT NULL DEFAULT '',
    "criterioDerivacion" VARCHAR(2000) NOT NULL DEFAULT '',
    "leerComprobantes" BOOLEAN NOT NULL DEFAULT false,
    "actualizadoEn" TIMESTAMP(3) NOT NULL,
    "actualizadoPorId" TEXT,

    CONSTRAINT "AsistenteLinea_pkey" PRIMARY KEY ("lineaId")
);

-- CreateTable
CREATE TABLE "SugerenciaAsistente" (
    "id" TEXT NOT NULL,
    "conversacionId" TEXT NOT NULL,
    "mensajeId" TEXT NOT NULL,
    "texto" VARCHAR(4096) NOT NULL,
    "acciones" JSONB NOT NULL,
    "aviso" VARCHAR(300),
    "estado" "EstadoSugerencia" NOT NULL DEFAULT 'PENDIENTE',
    "resueltaEn" TIMESTAMP(3),
    "resueltaPorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SugerenciaAsistente_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TurnoAsistente" (
    "id" TEXT NOT NULL,
    "conversacionId" TEXT NOT NULL,
    "lineaId" TEXT NOT NULL,
    "mensajeId" TEXT NOT NULL,
    "modo" "ModoAsistente" NOT NULL,
    "resultado" "ResultadoTurnoAsistente" NOT NULL,
    "motivo" VARCHAR(300),
    "categoria" VARCHAR(30),
    "herramientas" JSONB NOT NULL,
    "modelo" VARCHAR(60),
    "tokensEntrada" INTEGER NOT NULL DEFAULT 0,
    "tokensSalida" INTEGER NOT NULL DEFAULT 0,
    "latenciaMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TurnoAsistente_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SugerenciaAsistente_conversacionId_estado_idx" ON "SugerenciaAsistente"("conversacionId", "estado");

-- CreateIndex
CREATE INDEX "SugerenciaAsistente_resueltaPorId_idx" ON "SugerenciaAsistente"("resueltaPorId");

-- CreateIndex
CREATE INDEX "TurnoAsistente_conversacionId_createdAt_idx" ON "TurnoAsistente"("conversacionId", "createdAt");

-- CreateIndex
CREATE INDEX "TurnoAsistente_lineaId_createdAt_idx" ON "TurnoAsistente"("lineaId", "createdAt");

-- AddForeignKey
ALTER TABLE "AsistenteLinea" ADD CONSTRAINT "AsistenteLinea_lineaId_fkey" FOREIGN KEY ("lineaId") REFERENCES "LineaWhatsapp"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AsistenteLinea" ADD CONSTRAINT "AsistenteLinea_actualizadoPorId_fkey" FOREIGN KEY ("actualizadoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SugerenciaAsistente" ADD CONSTRAINT "SugerenciaAsistente_conversacionId_fkey" FOREIGN KEY ("conversacionId") REFERENCES "Conversacion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SugerenciaAsistente" ADD CONSTRAINT "SugerenciaAsistente_resueltaPorId_fkey" FOREIGN KEY ("resueltaPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TurnoAsistente" ADD CONSTRAINT "TurnoAsistente_conversacionId_fkey" FOREIGN KEY ("conversacionId") REFERENCES "Conversacion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

