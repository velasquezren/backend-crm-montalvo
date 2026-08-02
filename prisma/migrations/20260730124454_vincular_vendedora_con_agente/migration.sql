-- AlterTable
ALTER TABLE "Usuario" ADD COLUMN     "codigo" VARCHAR(40);

-- CreateIndex
CREATE UNIQUE INDEX "Usuario_codigo_key" ON "Usuario"("codigo");

-- NOTA HISTÓRICA (reparación del 2026-08-01)
--
-- Esta migración añadía además `VendedoraComision.usuarioId` con su índice único
-- y su FK a Usuario. Se quitaron de aquí porque la historia no se podía reproducir
-- en una base nueva:
--
--   · Las migraciones se aplican en orden alfabético. Por timestamp, esta (124454)
--     corre ANTES que `20260730153324_planilla_comisiones`, que es la que CREA la
--     tabla "VendedoraComision" — así que el ALTER fallaba con P1014 en cualquier
--     base virgen y en la shadow database de `prisma migrate dev`.
--   · En producción nunca falló porque allí se aplicaron en otro orden: primero
--     `planilla_comisiones` (30/07 12:18) y luego esta (30/07 12:52).
--
-- Quitarlas no cambia el esquema resultante: dos migraciones más adelante,
-- `20260730130008_rol_super_admin_y_cruce_por_codigo` revierte ese diseño y hace
-- DROP de la columna, el índice y la FK — el cruce vendedora→agente pasó a
-- resolverse por `codigo`, que es lo que sigue vivo (ver `Usuario.codigo` arriba
-- y el modelo VendedoraComision en schema.prisma, que no tiene `usuarioId`).
--
-- Efecto neto de aquellas tres sentencias: cero. Por eso se eliminan en vez de
-- envolverlas en guardas condicionales que nunca se cumplirían en una base nueva.
