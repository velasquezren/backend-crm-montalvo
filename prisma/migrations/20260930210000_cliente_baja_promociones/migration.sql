-- Quien pidió no recibir más promociones (botón «No me interesa»/«Baja» de una
-- plantilla de Marketing). Aditiva y nula: nadie queda dado de baja al migrar.
ALTER TABLE "Cliente" ADD COLUMN "bajaPromocionesEn" TIMESTAMP(3);
