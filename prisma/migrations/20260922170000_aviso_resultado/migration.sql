-- Registro de qué informe del portal de resultados ya se avisó por WhatsApp.
-- El único sobre "informeId" es la guardia contra el doble envío: una
-- comprobación previa la gana una carrera, el índice no.
CREATE TABLE "AvisoResultado" (
    "id" TEXT NOT NULL,
    "informeId" VARCHAR(64) NOT NULL,
    "clienteId" TEXT NOT NULL,
    "mensajeId" TEXT,
    "enviadoPorId" TEXT NOT NULL,
    "enviadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AvisoResultado_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AvisoResultado_informeId_key" ON "AvisoResultado"("informeId");
CREATE UNIQUE INDEX "AvisoResultado_mensajeId_key" ON "AvisoResultado"("mensajeId");
CREATE INDEX "AvisoResultado_clienteId_enviadoEn_idx" ON "AvisoResultado"("clienteId", "enviadoEn");
ALTER TABLE "AvisoResultado" ADD CONSTRAINT "AvisoResultado_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "Cliente"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AvisoResultado" ADD CONSTRAINT "AvisoResultado_mensajeId_fkey" FOREIGN KEY ("mensajeId") REFERENCES "Mensaje"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AvisoResultado" ADD CONSTRAINT "AvisoResultado_enviadoPorId_fkey" FOREIGN KEY ("enviadoPorId") REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
