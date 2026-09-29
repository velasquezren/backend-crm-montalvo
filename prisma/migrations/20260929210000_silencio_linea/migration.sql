-- Fase 1 de 2 (expand): la preferencia de aviso sale del acceso a su propia
-- tabla, para que valga también para quien ve una línea sin fila de acceso
-- (los administradores). La columna vieja se borra en la migración siguiente,
-- no aquí: el proceso anterior la sigue leyendo mientras compila el nuevo.

-- CreateTable
CREATE TABLE "SilencioLinea" (
    "usuarioId" TEXT NOT NULL,
    "lineaId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SilencioLinea_pkey" PRIMARY KEY ("usuarioId","lineaId")
);

-- CreateIndex
CREATE INDEX "SilencioLinea_lineaId_idx" ON "SilencioLinea"("lineaId");

-- AddForeignKey
ALTER TABLE "SilencioLinea" ADD CONSTRAINT "SilencioLinea_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "Usuario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SilencioLinea" ADD CONSTRAINT "SilencioLinea_lineaId_fkey" FOREIGN KEY ("lineaId") REFERENCES "LineaWhatsapp"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Lo silenciado hasta hoy se conserva tal cual.
INSERT INTO "SilencioLinea" ("usuarioId", "lineaId")
SELECT "usuarioId", "lineaId" FROM "AccesoLineaWhatsapp" WHERE "notificar" = false;
