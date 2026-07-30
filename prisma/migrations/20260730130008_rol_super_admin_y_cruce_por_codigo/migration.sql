-- Rol SUPER_ADMIN: gestiona agentes (les asigna el código de empresa) e importa
-- la planilla. La jerarquía vive en RolesGuard (SUPER_ADMIN cubre a ADMIN).
ALTER TYPE "Rol" ADD VALUE IF NOT EXISTS 'SUPER_ADMIN';

-- Se elimina el enlace almacenado vendedora→agente: ahora el cruce se hace por
-- `codigo` (el `vendedora_pk` del Excel es el mismo identificador del agente),
-- así que no hay nada que mantener sincronizado ni que vincular a mano.
DROP INDEX IF EXISTS "VendedoraComision_usuarioId_key";
ALTER TABLE "VendedoraComision" DROP CONSTRAINT IF EXISTS "VendedoraComision_usuarioId_fkey";
ALTER TABLE "VendedoraComision" DROP COLUMN IF EXISTS "usuarioId";
