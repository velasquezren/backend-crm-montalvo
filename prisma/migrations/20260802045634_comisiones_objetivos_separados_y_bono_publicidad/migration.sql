-- Objetivos de planes: uno solo pasa a ser dos.
--
-- `planesMinimos` guardaba el objetivo de paquetes de maternidad, así que se
-- RENOMBRA en vez de recrearse: los valores que administración ya configuró
-- (4 vendedora / 6 jefa) siguen siendo válidos y se conservan. Prisma proponía
-- DROP + ADD NOT NULL sin default, que sobre una tabla con filas falla.
ALTER TABLE "ObjetivoComision" RENAME COLUMN "planesMinimos" TO "planpaqMinimos";

-- Objetivo propio de los planes varios / niño sano (PLANNIN). Por defecto 1,
-- que es el valor de la planilla para ambos tipos de vendedora.
ALTER TABLE "ObjetivoComision" ADD COLUMN "planninMinimos" INTEGER NOT NULL DEFAULT 1;

-- Bono de publicidad: hasta ahora se guardaba dentro de `bonoJefatura`, lo que
-- impedía distinguir el pote que genera el equipo del que cobra publicidad.
ALTER TABLE "ResultadoComision" ADD COLUMN "bonoPublicidad" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- Desglose del Tipo A: cuántos planes se vendieron y cuántos superaron el
-- objetivo. Sin esto no se puede explicar por qué una vendedora cobró lo que cobró.
ALTER TABLE "ResultadoComision" ADD COLUMN "planpaqVendidos"      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ResultadoComision" ADD COLUMN "planpaqComisionables" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ResultadoComision" ADD COLUMN "planninVendidos"      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ResultadoComision" ADD COLUMN "planninComisionables" INTEGER NOT NULL DEFAULT 0;
