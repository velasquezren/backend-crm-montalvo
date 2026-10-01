-- AlterTable
ALTER TABLE "Cliente" ADD COLUMN     "categoriaFijadaEn" TIMESTAMP(3),
ADD COLUMN     "categoriaFijadaPorId" TEXT;

-- AddForeignKey
ALTER TABLE "Cliente" ADD CONSTRAINT "Cliente_categoriaFijadaPorId_fkey" FOREIGN KEY ("categoriaFijadaPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Respetar lo que ya se puso a mano. Hasta hoy la categoría solo salía de las
-- ventas del CRM o de la ficha editada a mano; una distinta de Prospecto SIN
-- ninguna venta ganada solo pudo ponerla una persona. Se marca como fijada para
-- que el cálculo por valor no la borre. En producción eran dos (una Gold y una
-- Bronze, 2026-09-30); se devuelven a automática desde la ficha.
UPDATE "Cliente" c
SET "categoriaFijadaEn" = CURRENT_TIMESTAMP
WHERE c.categoria <> 'PROSPECTO'
  AND NOT EXISTS (SELECT 1 FROM "Venta" v WHERE v."clienteId" = c.id AND v.estado = 'GANADA');
