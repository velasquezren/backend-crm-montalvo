-- Conversación abierta/cerrada, como los inbox serios: cerrada = resuelta, sale
-- de las pestañas de trabajo y se reabre sola con el siguiente mensaje. Nulas:
-- al migrar, todas siguen abiertas; el barrido por inactividad las cierra luego.
ALTER TABLE "Conversacion" ADD COLUMN     "cerradaEn" TIMESTAMP(3),
ADD COLUMN     "cerradaPorId" TEXT;

-- Quién la cerró. Si la cuenta se diera de baja física, queda como cerrada por
-- el sistema en vez de impedir el borrado.
ALTER TABLE "Conversacion" ADD CONSTRAINT "Conversacion_cerradaPorId_fkey" FOREIGN KEY ("cerradaPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;
