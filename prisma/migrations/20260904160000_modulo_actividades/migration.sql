-- CreateEnum
CREATE TYPE "TipoActividad" AS ENUM ('LLAMADA', 'REUNION', 'TAREA', 'RECORDATORIO');

-- CreateEnum
CREATE TYPE "EstadoActividad" AS ENUM ('PENDIENTE', 'COMPLETADA', 'CANCELADA');

-- CreateTable
CREATE TABLE "Actividad" (
    "id" TEXT NOT NULL,
    "tipo" "TipoActividad" NOT NULL DEFAULT 'TAREA',
    "titulo" VARCHAR(200) NOT NULL,
    "notas" VARCHAR(1000),
    "fechaProgramada" TIMESTAMP(3) NOT NULL,
    "estado" "EstadoActividad" NOT NULL DEFAULT 'PENDIENTE',
    "clienteId" TEXT NOT NULL,
    "leadId" TEXT,
    "agenteId" TEXT NOT NULL,
    "completadaEn" TIMESTAMP(3),
    "notificadaEn" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Actividad_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Actividad_agenteId_fechaProgramada_idx" ON "Actividad"("agenteId", "fechaProgramada");

-- CreateIndex
CREATE INDEX "Actividad_agenteId_estado_idx" ON "Actividad"("agenteId", "estado");

-- CreateIndex
CREATE INDEX "Actividad_clienteId_idx" ON "Actividad"("clienteId");

-- CreateIndex
CREATE INDEX "Actividad_leadId_idx" ON "Actividad"("leadId");

-- CreateIndex
CREATE INDEX "Actividad_estado_notificadaEn_fechaProgramada_idx" ON "Actividad"("estado", "notificadaEn", "fechaProgramada");

-- AddForeignKey
ALTER TABLE "Actividad" ADD CONSTRAINT "Actividad_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "Cliente"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Actividad" ADD CONSTRAINT "Actividad_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Actividad" ADD CONSTRAINT "Actividad_agenteId_fkey" FOREIGN KEY ("agenteId") REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

