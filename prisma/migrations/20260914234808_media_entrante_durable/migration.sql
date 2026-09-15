-- CreateTable
CREATE TABLE "TrabajoMediaEntrante" (
    "mensajeId" TEXT NOT NULL,
    "mediaId" VARCHAR(255) NOT NULL,
    "estado" VARCHAR(20) NOT NULL DEFAULT 'PENDIENTE',
    "intentos" INTEGER NOT NULL DEFAULT 0,
    "proximoIntento" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "ultimoError" VARCHAR(80),
    "reclamadoEn" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrabajoMediaEntrante_pkey" PRIMARY KEY ("mensajeId")
);

-- CreateIndex
CREATE INDEX "TrabajoMediaEntrante_proximoIntento_mensajeId_idx" ON "TrabajoMediaEntrante"("proximoIntento", "mensajeId");

-- AddForeignKey
ALTER TABLE "TrabajoMediaEntrante" ADD CONSTRAINT "TrabajoMediaEntrante_mensajeId_fkey" FOREIGN KEY ("mensajeId") REFERENCES "Mensaje"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Estados internos: no amplían los enums públicos consumidos por el frontend.
ALTER TABLE "TrabajoMediaEntrante"
  ADD CONSTRAINT "TrabajoMediaEntrante_estado_check"
    CHECK ("estado" IN ('PENDIENTE','PROCESANDO','REINTENTABLE','COMPLETADO','DESCARTADO','AGOTADO')),
  ADD CONSTRAINT "TrabajoMediaEntrante_intentos_check" CHECK ("intentos" BETWEEN 0 AND 8),
  ADD CONSTRAINT "TrabajoMediaEntrante_mediaId_check" CHECK (length("mediaId") > 0),
  ADD CONSTRAINT "TrabajoMediaEntrante_agenda_check"
    CHECK (("estado" IN ('COMPLETADO','DESCARTADO','AGOTADO')) = ("proximoIntento" IS NULL)),
  ADD CONSTRAINT "TrabajoMediaEntrante_reclamacion_check"
    CHECK ("estado" <> 'PROCESANDO' OR "reclamadoEn" IS NOT NULL);
