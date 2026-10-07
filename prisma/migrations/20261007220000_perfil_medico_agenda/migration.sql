-- La ficha web de un médico, enlazada a su médico de la agenda (ScriptCase).
-- Solo AÑADE: columna nula + índice único (un médico de la agenda, una ficha).
ALTER TABLE "PerfilMedico" ADD COLUMN "agendaMedicoId" INTEGER;

CREATE UNIQUE INDEX "PerfilMedico_agendaMedicoId_key" ON "PerfilMedico"("agendaMedicoId");
