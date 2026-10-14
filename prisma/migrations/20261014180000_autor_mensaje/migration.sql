-- Quién del equipo escribió cada mensaje saliente. Nullable y sin backfill:
-- lo anterior no lo guardó, y lo automático y lo entrante no tienen autor.
ALTER TABLE "Mensaje" ADD COLUMN "autorId" TEXT;

-- AddForeignKey
ALTER TABLE "Mensaje" ADD CONSTRAINT "Mensaje_autorId_fkey" FOREIGN KEY ("autorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;
