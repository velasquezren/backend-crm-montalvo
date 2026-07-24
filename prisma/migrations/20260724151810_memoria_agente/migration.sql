-- CreateEnum
CREATE TYPE "TipoRecursoMemoria" AS ENUM ('TEXTO', 'IMAGEN', 'DOCUMENTO', 'ENLACE');

-- CreateEnum
CREATE TYPE "CategoriaRecursoMemoria" AS ENUM ('GENERAL', 'RESPUESTA_RAPIDA', 'PROMOCION', 'PRECIOS', 'PRODUCTO_TRATAMIENTO', 'INSTRUCCION_INTERNA');

-- CreateTable
CREATE TABLE "RecursoMemoriaAgente" (
    "id" TEXT NOT NULL,
    "usuarioId" TEXT NOT NULL,
    "titulo" VARCHAR(120) NOT NULL,
    "contenido" TEXT,
    "tipo" "TipoRecursoMemoria" NOT NULL DEFAULT 'TEXTO',
    "categoria" "CategoriaRecursoMemoria" NOT NULL DEFAULT 'GENERAL',
    "atajo" VARCHAR(35),
    "mediaKey" VARCHAR(255),
    "mediaMime" VARCHAR(100),
    "mediaNombre" VARCHAR(255),
    "pesoBytes" INTEGER NOT NULL DEFAULT 0,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecursoMemoriaAgente_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecursoMemoriaAgente_usuarioId_categoria_idx" ON "RecursoMemoriaAgente"("usuarioId", "categoria");

-- CreateIndex
CREATE INDEX "RecursoMemoriaAgente_usuarioId_tipo_idx" ON "RecursoMemoriaAgente"("usuarioId", "tipo");

-- CreateIndex
CREATE INDEX "RecursoMemoriaAgente_usuarioId_atajo_idx" ON "RecursoMemoriaAgente"("usuarioId", "atajo");

-- CreateIndex
CREATE INDEX "RecursoMemoriaAgente_usuarioId_createdAt_idx" ON "RecursoMemoriaAgente"("usuarioId", "createdAt");

-- AddForeignKey
ALTER TABLE "RecursoMemoriaAgente" ADD CONSTRAINT "RecursoMemoriaAgente_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "Usuario"("id") ON DELETE CASCADE ON UPDATE CASCADE;
