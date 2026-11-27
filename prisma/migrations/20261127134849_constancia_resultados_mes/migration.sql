-- CreateTable
CREATE TABLE "ConstanciaResultadosMes" (
    "mes" CHAR(7) NOT NULL,
    "validadaEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validadaPorId" TEXT NOT NULL,
    "validadaPorNombre" VARCHAR(120) NOT NULL,
    "totalAvisos" INTEGER NOT NULL,
    "copia" JSONB NOT NULL,

    CONSTRAINT "ConstanciaResultadosMes_pkey" PRIMARY KEY ("mes")
);

-- El mes en la forma AAAA-MM, también si alguien escribe sin pasar por el DTO.
ALTER TABLE "ConstanciaResultadosMes"
  ADD CONSTRAINT "ConstanciaResultadosMes_mes_formato" CHECK ("mes" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
