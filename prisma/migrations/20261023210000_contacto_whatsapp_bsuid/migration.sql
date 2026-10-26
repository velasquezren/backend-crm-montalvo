-- Nombres de usuario de WhatsApp (BSUID). Aditiva: se puede aplicar con el
-- proceso anterior vivo, que sigue dando de alta fichas siempre con teléfono.
--
-- Quien adoptó un nombre de usuario y escribe por primera vez llega sin teléfono,
-- solo con su BSUID. Hasta hoy el webhook descartaba ese mensaje (sin `from`).
ALTER TABLE "Cliente" ADD COLUMN     "waUsuarioId" VARCHAR(160),
ALTER COLUMN "telefono" DROP NOT NULL;

CREATE UNIQUE INDEX "Cliente_waUsuarioId_key" ON "Cliente"("waUsuarioId");

-- Una ficha sin teléfono ni BSUID no tendría por dónde recibir ni enviar nada.
-- Prisma no modela CHECK: vive solo aquí, y `migrate diff` no lo toca.
ALTER TABLE "Cliente" ADD CONSTRAINT "Cliente_contacto_whatsapp_check"
  CHECK ("telefono" IS NOT NULL OR "waUsuarioId" IS NOT NULL);
