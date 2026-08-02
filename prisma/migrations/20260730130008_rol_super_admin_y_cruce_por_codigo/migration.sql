-- Rol SUPER_ADMIN: gestiona agentes (les asigna el código de empresa) e importa
-- la planilla. La jerarquía vive en RolesGuard (SUPER_ADMIN cubre a ADMIN).
ALTER TYPE "Rol" ADD VALUE IF NOT EXISTS 'SUPER_ADMIN';

-- Se elimina el enlace almacenado vendedora→agente: ahora el cruce se hace por
-- `codigo` (el `vendedora_pk` del Excel es el mismo identificador del agente),
-- así que no hay nada que mantener sincronizado ni que vincular a mano.
-- `ALTER TABLE IF EXISTS` (y no solo `DROP ... IF EXISTS`): en una base nueva las
-- migraciones corren en orden alfabético, y esta (130008) va antes que
-- `20260730153324_planilla_comisiones`, la que crea "VendedoraComision". Sin el
-- `IF EXISTS` de la tabla, Postgres aborta con «relation does not exist» —
-- el `IF EXISTS` del DROP solo cubre la columna/constraint, no la tabla.
DROP INDEX IF EXISTS "VendedoraComision_usuarioId_key";
ALTER TABLE IF EXISTS "VendedoraComision" DROP CONSTRAINT IF EXISTS "VendedoraComision_usuarioId_fkey";
ALTER TABLE IF EXISTS "VendedoraComision" DROP COLUMN IF EXISTS "usuarioId";
