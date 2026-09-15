-- CreateTable
CREATE TABLE "PrimerContactoWhatsapp" (
    "conversacionId" TEXT NOT NULL,
    "mensajeId" TEXT,
    "origen" "OrigenLead",
    "anuncioId" VARCHAR(64),
    "leadId" TEXT,
    "intentos" INTEGER NOT NULL DEFAULT 0,
    "proximoIntento" TIMESTAMP(3),
    "ultimoError" VARCHAR(80),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrimerContactoWhatsapp_pkey" PRIMARY KEY ("conversacionId")
);

-- CreateIndex
CREATE UNIQUE INDEX "PrimerContactoWhatsapp_mensajeId_key" ON "PrimerContactoWhatsapp"("mensajeId");

-- CreateIndex
CREATE UNIQUE INDEX "PrimerContactoWhatsapp_leadId_key" ON "PrimerContactoWhatsapp"("leadId");

-- CreateIndex
CREATE INDEX "PrimerContactoWhatsapp_proximoIntento_conversacionId_idx" ON "PrimerContactoWhatsapp"("proximoIntento", "conversacionId");

-- AddForeignKey
ALTER TABLE "PrimerContactoWhatsapp" ADD CONSTRAINT "PrimerContactoWhatsapp_conversacionId_fkey" FOREIGN KEY ("conversacionId") REFERENCES "Conversacion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrimerContactoWhatsapp" ADD CONSTRAINT "PrimerContactoWhatsapp_mensajeId_fkey" FOREIGN KEY ("mensajeId") REFERENCES "Mensaje"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrimerContactoWhatsapp" ADD CONSTRAINT "PrimerContactoWhatsapp_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Los estados se derivan de los enlaces: no hay flags independientes que desincronizar.
ALTER TABLE "PrimerContactoWhatsapp" ADD CONSTRAINT "PrimerContactoWhatsapp_estado_check" CHECK (
  ("mensajeId" IS NULL AND "origen" IS NULL AND "anuncioId" IS NULL
    AND "leadId" IS NULL AND "proximoIntento" IS NULL AND "intentos" = 0 AND "ultimoError" IS NULL)
  OR
  ("mensajeId" IS NOT NULL AND "origen" IS NOT NULL AND "leadId" IS NULL
    AND "proximoIntento" IS NOT NULL AND "intentos" >= 0)
  OR
  ("mensajeId" IS NOT NULL AND "origen" IS NOT NULL AND "leadId" IS NOT NULL
    AND "proximoIntento" IS NULL AND "intentos" > 0 AND "ultimoError" IS NULL)
);
