-- Marca los mensajes que envía el sistema (acuse fuera de horario) para poder
-- distinguirlos de una respuesta humana. Ver el comentario del campo en
-- schema.prisma: sin esto, un acuse automático sacaría la conversación de la
-- pestaña "Sin responder" y el lunes nadie sabría quién escribió.
ALTER TABLE "Mensaje" ADD COLUMN "automatico" BOOLEAN NOT NULL DEFAULT false;
