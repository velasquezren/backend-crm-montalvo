-- CreateTable
CREATE TABLE "InteraccionMensaje" (
    "mensajeId" TEXT NOT NULL,
    "privado" TEXT,
    "vista" JSONB NOT NULL,
    "estado" VARCHAR(32) NOT NULL,
    "consumidaPor" TEXT,
    "venceEn" TIMESTAMP(3) NOT NULL,
    "purgarEn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InteraccionMensaje_pkey" PRIMARY KEY ("mensajeId")
);

-- CreateIndex
CREATE INDEX "InteraccionMensaje_purgarEn_idx" ON "InteraccionMensaje"("purgarEn");

-- AddForeignKey
ALTER TABLE "InteraccionMensaje" ADD CONSTRAINT "InteraccionMensaje_mensajeId_fkey" FOREIGN KEY ("mensajeId") REFERENCES "Mensaje"("id") ON DELETE CASCADE ON UPDATE CASCADE;
