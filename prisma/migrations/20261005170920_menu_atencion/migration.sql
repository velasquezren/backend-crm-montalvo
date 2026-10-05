-- AlterEnum
-- BEFORE: Postgres ordena un enum por su declaración y ese orden ES la prioridad
-- de la pestaña «Atención» (ORDEN_ATENCION). Al final, una emergencia quedaría
-- detrás de una revisión.
ALTER TYPE "MotivoAtencion" ADD VALUE 'EMERGENCIA' BEFORE 'SOLICITUD_EXPLICITA';

-- CreateTable
CREATE TABLE "MenuAtencion" (
    "lineaId" TEXT NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT false,
    "saludo" VARCHAR(1024) NOT NULL,
    "opciones" JSONB NOT NULL,
    "promociones" JSONB NOT NULL DEFAULT '[]',
    "actualizadoEn" TIMESTAMP(3) NOT NULL,
    "actualizadoPorId" TEXT,

    CONSTRAINT "MenuAtencion_pkey" PRIMARY KEY ("lineaId")
);

-- AddForeignKey
ALTER TABLE "MenuAtencion" ADD CONSTRAINT "MenuAtencion_lineaId_fkey" FOREIGN KEY ("lineaId") REFERENCES "LineaWhatsapp"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuAtencion" ADD CONSTRAINT "MenuAtencion_actualizadoPorId_fkey" FOREIGN KEY ("actualizadoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;
