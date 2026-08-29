-- AlterEnum
ALTER TYPE "EstadoPeriodo" ADD VALUE 'EN_REVISION';
ALTER TYPE "EstadoPeriodo" ADD VALUE 'PAGADO';

-- AlterTable
ALTER TABLE "PeriodoComision" ADD COLUMN     "cerradoEn" TIMESTAMP(3),
ADD COLUMN     "cerradoPor" TEXT,
ADD COLUMN     "enRevisionDesde" TIMESTAMP(3),
ADD COLUMN     "enviadoARevisionPor" TEXT,
ADD COLUMN     "pagadoEn" TIMESTAMP(3),
ADD COLUMN     "pagadoPor" TEXT;

-- CreateTable
CREATE TABLE "AprobacionPeriodo" (
    "id" TEXT NOT NULL,
    "periodoId" TEXT NOT NULL,
    "usuarioId" TEXT NOT NULL,
    "comentario" VARCHAR(300),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AprobacionPeriodo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AprobacionPeriodo_periodoId_idx" ON "AprobacionPeriodo"("periodoId");

-- CreateIndex
CREATE UNIQUE INDEX "AprobacionPeriodo_periodoId_usuarioId_key" ON "AprobacionPeriodo"("periodoId", "usuarioId");

-- AddForeignKey
ALTER TABLE "AprobacionPeriodo" ADD CONSTRAINT "AprobacionPeriodo_periodoId_fkey" FOREIGN KEY ("periodoId") REFERENCES "PeriodoComision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AprobacionPeriodo" ADD CONSTRAINT "AprobacionPeriodo_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "Usuario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Los periodos que ya estaban CERRADOS se quedan como están: no se inventa
-- quién los cerró ni cuándo. `cerradoPor`/`cerradoEn` quedan en NULL y la
-- pantalla lo dice ("cerrado antes de que se registrara quién"), que es
-- honesto; rellenarlos con el primer SUPER_ADMIN que aparezca sería fabricar
-- una firma que nadie dio.
