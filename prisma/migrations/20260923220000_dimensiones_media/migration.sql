-- Dimensiones de las imágenes, para reservar su caja en el chat antes de que
-- lleguen. Aditivas y nulas: lo existente no cambia.
ALTER TABLE "Mensaje" ADD COLUMN "mediaAncho" INTEGER, ADD COLUMN "mediaAlto" INTEGER;
ALTER TABLE "RecursoMemoriaAgente" ADD COLUMN "mediaAncho" INTEGER, ADD COLUMN "mediaAlto" INTEGER;
