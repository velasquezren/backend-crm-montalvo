-- CreateEnum
CREATE TYPE "EstadoMensaje" AS ENUM ('ENVIADO', 'ENTREGADO', 'LEIDO', 'FALLIDO');

-- AlterTable
ALTER TABLE "Mensaje" ADD COLUMN     "entregadoEn" TIMESTAMP(3),
ADD COLUMN     "estadoEnvio" "EstadoMensaje",
ADD COLUMN     "leidoEn" TIMESTAMP(3);
