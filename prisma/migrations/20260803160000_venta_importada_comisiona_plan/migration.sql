-- Qué plan concreto comisiona cuando la vendedora supera su objetivo.
-- NULL = lo decide el sistema; true/false = decisión manual de administración.
-- Reemplaza a la columna "PLANPAG COMISIONABLE" que se escribía a mano en el Excel.
ALTER TABLE "VentaImportada" ADD COLUMN "comisionaPlan" BOOLEAN;
