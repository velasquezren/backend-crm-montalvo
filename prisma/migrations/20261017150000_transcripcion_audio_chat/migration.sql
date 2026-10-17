CREATE TABLE "TrabajoTranscripcionAudio" (
    "mensajeId" TEXT NOT NULL,
    "intentos" INTEGER NOT NULL DEFAULT 0,
    "proximoIntento" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "ultimoError" VARCHAR(80),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrabajoTranscripcionAudio_pkey" PRIMARY KEY ("mensajeId"),
    CONSTRAINT "TrabajoTranscripcionAudio_intentos_check" CHECK ("intentos" >= 0 AND "intentos" <= 3)
);
CREATE INDEX "TrabajoTranscripcionAudio_proximoIntento_mensajeId_idx" ON "TrabajoTranscripcionAudio"("proximoIntento", "mensajeId");
ALTER TABLE "TrabajoTranscripcionAudio" ADD CONSTRAINT "TrabajoTranscripcionAudio_mensajeId_fkey" FOREIGN KEY ("mensajeId") REFERENCES "Mensaje"("id") ON DELETE CASCADE ON UPDATE CASCADE;
