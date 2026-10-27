-- Ausencias (vacaciones, congreso) del médico de la AGENDA, no solo de su ficha web.
-- Aditiva: columna nueva, `perfilMedicoId` pasa a opcional y las ausencias de fichas
-- enlazadas a la agenda pasan a su médico (la ficha se puede borrar; las vacaciones no).
-- Ver docs/agenda.md, «Vacaciones y ausencias».
ALTER TABLE "AusenciaMedico" ALTER COLUMN "perfilMedicoId" DROP NOT NULL;
ALTER TABLE "AusenciaMedico" ADD COLUMN "agendaMedicoId" INTEGER;

UPDATE "AusenciaMedico" a
   SET "agendaMedicoId" = p."agendaMedicoId", "perfilMedicoId" = NULL
  FROM "PerfilMedico" p
 WHERE a."perfilMedicoId" = p."id" AND p."agendaMedicoId" IS NOT NULL;

-- De uno solo: del médico de la agenda o de una ficha sin agenda.
ALTER TABLE "AusenciaMedico" ADD CONSTRAINT "AusenciaMedico_un_dueno" CHECK (num_nonnulls("perfilMedicoId", "agendaMedicoId") = 1);
ALTER TABLE "AusenciaMedico" ADD CONSTRAINT "AusenciaMedico_rango" CHECK ("desde" <= "hasta");

CREATE INDEX "AusenciaMedico_agendaMedicoId_hasta_idx" ON "AusenciaMedico"("agendaMedicoId", "hasta");
