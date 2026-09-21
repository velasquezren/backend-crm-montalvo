-- AlterTable
ALTER TABLE "Mensaje" ADD COLUMN     "codigoErrorEnvio" INTEGER,
ADD COLUMN     "permiteReintento" BOOLEAN NOT NULL DEFAULT true;

