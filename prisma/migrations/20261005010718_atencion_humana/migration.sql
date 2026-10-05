-- CreateEnum
CREATE TYPE "MotivoAtencion" AS ENUM ('SOLICITUD_EXPLICITA', 'SOLICITUD_CITA', 'REVISION');

-- AlterTable
ALTER TABLE "Conversacion" ADD COLUMN     "atencionMensajeId" TEXT,
ADD COLUMN     "atencionMotivo" "MotivoAtencion",
ADD COLUMN     "atencionSolicitadaEn" TIMESTAMP(3),
ADD COLUMN     "atencionTomadaEn" TIMESTAMP(3),
ADD COLUMN     "atencionTomadaPorId" TEXT,
ADD COLUMN     "automatizacionPausadaEn" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Conversacion_atencionSolicitadaEn_idx" ON "Conversacion"("atencionSolicitadaEn");

-- AddForeignKey
ALTER TABLE "Conversacion" ADD CONSTRAINT "Conversacion_atencionTomadaPorId_fkey" FOREIGN KEY ("atencionTomadaPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;
