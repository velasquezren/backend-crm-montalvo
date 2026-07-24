-- CreateEnum
CREATE TYPE "TipoMensaje" AS ENUM ('TEXTO', 'IMAGEN', 'DOCUMENTO', 'AUDIO', 'VIDEO', 'STICKER');

-- AlterTable
ALTER TABLE "Mensaje" ADD COLUMN     "mediaKey" TEXT,
ADD COLUMN     "mediaMime" TEXT,
ADD COLUMN     "mediaNombre" TEXT,
ADD COLUMN     "tipo" "TipoMensaje" NOT NULL DEFAULT 'TEXTO';

