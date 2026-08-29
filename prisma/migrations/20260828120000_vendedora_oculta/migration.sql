-- AlterTable
ALTER TABLE "VendedoraComision" ADD COLUMN     "motivoOculta" VARCHAR(200),
ADD COLUMN     "oculta" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ocultaDesde" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "VendedoraComision_oculta_idx" ON "VendedoraComision"("oculta");

-- Sin backfill a propósito: `oculta` nace en false para TODAS, incluidas las que
-- ya estén con `activa = false`. Son dos decisiones distintas y no se pueden
-- deducir la una de la otra — desactivar es "deja de liquidarse", ocultar es "ya
-- no trabaja aquí y no quiero verla en los informes". Marcar automáticamente
-- como ocultas a las inactivas las sacaría de la planilla sin que nadie lo haya
-- pedido y sin motivo registrado, que es justo lo que este campo existe para
-- impedir.
