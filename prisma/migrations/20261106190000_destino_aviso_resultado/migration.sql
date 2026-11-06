-- El WhatsApp de OTRA ficha (un familiar) al que FileMaker pidió mandar el aviso de
-- un informe. Aditiva: tabla nueva, sin tocar fichas ni avisos existentes.
-- Ver docs/filemaker-avisos-ecografia.md, «Enviar a un número de otra ficha».
CREATE TABLE "DestinoAvisoResultado" (
    "informeId" VARCHAR(64) NOT NULL,
    "clienteId" TEXT NOT NULL,
    "usuarioFilemaker" VARCHAR(100) NOT NULL,
    "elegidoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DestinoAvisoResultado_pkey" PRIMARY KEY ("informeId")
);

CREATE INDEX "DestinoAvisoResultado_clienteId_idx" ON "DestinoAvisoResultado"("clienteId");

ALTER TABLE "DestinoAvisoResultado" ADD CONSTRAINT "DestinoAvisoResultado_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "Cliente"("id") ON DELETE CASCADE ON UPDATE CASCADE;
