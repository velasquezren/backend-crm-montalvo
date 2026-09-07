ALTER TABLE "Usuario" ADD COLUMN "versionSesion" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "SesionUsuario" (
    "id" TEXT NOT NULL,
    "usuarioId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiraEn" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SesionUsuario_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SesionUsuario_usuarioId_expiraEn_idx" ON "SesionUsuario"("usuarioId", "expiraEn");
ALTER TABLE "SesionUsuario" ADD CONSTRAINT "SesionUsuario_usuarioId_fkey"
    FOREIGN KEY ("usuarioId") REFERENCES "Usuario"("id") ON DELETE CASCADE ON UPDATE CASCADE;
