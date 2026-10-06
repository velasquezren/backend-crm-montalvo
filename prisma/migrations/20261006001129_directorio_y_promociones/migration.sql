-- CreateEnum
CREATE TYPE "EstadoPromocion" AS ENUM ('BORRADOR', 'EN_REVISION', 'PUBLICADA', 'PAUSADA', 'ARCHIVADA');

-- CreateEnum
CREATE TYPE "FormatoBanner" AS ENUM ('CUADRADO', 'VERTICAL', 'HISTORIA', 'HORIZONTAL');

-- CreateTable
CREATE TABLE "Especialidad" (
    "id" TEXT NOT NULL,
    "nombre" VARCHAR(80) NOT NULL,
    "slug" VARCHAR(80) NOT NULL,
    "descripcion" VARCHAR(600) NOT NULL DEFAULT '',
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Especialidad_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerfilMedico" (
    "id" TEXT NOT NULL,
    "medicoId" TEXT,
    "nombrePublico" VARCHAR(120) NOT NULL,
    "slug" VARCHAR(120) NOT NULL,
    "resumen" VARCHAR(300) NOT NULL DEFAULT '',
    "biografia" VARCHAR(3000) NOT NULL DEFAULT '',
    "matricula" VARCHAR(40),
    "precioConsulta" DECIMAL(10,2),
    "fotoId" VARCHAR(40),
    "fotoClave" VARCHAR(200),
    "fotoMime" VARCHAR(40),
    "publicado" BOOLEAN NOT NULL DEFAULT false,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PerfilMedico_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerfilMedicoEspecialidad" (
    "perfilMedicoId" TEXT NOT NULL,
    "especialidadId" TEXT NOT NULL,

    CONSTRAINT "PerfilMedicoEspecialidad_pkey" PRIMARY KEY ("perfilMedicoId","especialidadId")
);

-- CreateTable
CREATE TABLE "HorarioMedico" (
    "id" TEXT NOT NULL,
    "perfilMedicoId" TEXT NOT NULL,
    "diaSemana" SMALLINT NOT NULL,
    "inicioMinuto" SMALLINT NOT NULL,
    "finMinuto" SMALLINT NOT NULL,
    "lugar" VARCHAR(80),

    CONSTRAINT "HorarioMedico_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AusenciaMedico" (
    "id" TEXT NOT NULL,
    "perfilMedicoId" TEXT NOT NULL,
    "desde" DATE NOT NULL,
    "hasta" DATE NOT NULL,
    "motivoPublico" VARCHAR(120),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AusenciaMedico_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Promocion" (
    "id" TEXT NOT NULL,
    "codigo" VARCHAR(16) NOT NULL,
    "slug" VARCHAR(90) NOT NULL,
    "titulo" VARCHAR(80) NOT NULL,
    "resumen" VARCHAR(160) NOT NULL,
    "descripcion" VARCHAR(4000) NOT NULL DEFAULT '',
    "condiciones" VARCHAR(2000) NOT NULL DEFAULT '',
    "etiquetaOferta" VARCHAR(24),
    "precioRegular" DECIMAL(10,2),
    "precioPromocional" DECIMAL(10,2),
    "vigenteDesde" DATE NOT NULL,
    "vigenteHasta" DATE,
    "estado" "EstadoPromocion" NOT NULL DEFAULT 'BORRADOR',
    "destacada" BOOLEAN NOT NULL DEFAULT false,
    "enLanding" BOOLEAN NOT NULL DEFAULT true,
    "enWhatsapp" BOOLEAN NOT NULL DEFAULT true,
    "especialidadId" TEXT,
    "creadaPorId" TEXT,
    "revisadaPorId" TEXT,
    "publicadaEn" TIMESTAMP(3),
    "motivoDevolucion" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Promocion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromocionImagen" (
    "id" TEXT NOT NULL,
    "promocionId" TEXT NOT NULL,
    "formato" "FormatoBanner" NOT NULL,
    "clave" VARCHAR(200) NOT NULL,
    "mime" VARCHAR(40) NOT NULL,
    "ancho" INTEGER NOT NULL,
    "alto" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    "textoAlternativo" VARCHAR(200) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromocionImagen_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromocionAnuncio" (
    "anuncioId" VARCHAR(64) NOT NULL,
    "promocionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromocionAnuncio_pkey" PRIMARY KEY ("anuncioId")
);

-- CreateTable
CREATE TABLE "PromocionMedico" (
    "promocionId" TEXT NOT NULL,
    "perfilMedicoId" TEXT NOT NULL,

    CONSTRAINT "PromocionMedico_pkey" PRIMARY KEY ("promocionId","perfilMedicoId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Especialidad_nombre_key" ON "Especialidad"("nombre");

-- CreateIndex
CREATE UNIQUE INDEX "Especialidad_slug_key" ON "Especialidad"("slug");

-- CreateIndex
CREATE INDEX "Especialidad_activa_orden_idx" ON "Especialidad"("activa", "orden");

-- CreateIndex
CREATE UNIQUE INDEX "PerfilMedico_medicoId_key" ON "PerfilMedico"("medicoId");

-- CreateIndex
CREATE UNIQUE INDEX "PerfilMedico_slug_key" ON "PerfilMedico"("slug");

-- CreateIndex
CREATE INDEX "PerfilMedico_publicado_orden_idx" ON "PerfilMedico"("publicado", "orden");

-- CreateIndex
CREATE INDEX "PerfilMedicoEspecialidad_especialidadId_idx" ON "PerfilMedicoEspecialidad"("especialidadId");

-- CreateIndex
CREATE INDEX "HorarioMedico_perfilMedicoId_diaSemana_idx" ON "HorarioMedico"("perfilMedicoId", "diaSemana");

-- CreateIndex
CREATE INDEX "AusenciaMedico_perfilMedicoId_hasta_idx" ON "AusenciaMedico"("perfilMedicoId", "hasta");

-- CreateIndex
CREATE UNIQUE INDEX "Promocion_codigo_key" ON "Promocion"("codigo");

-- CreateIndex
CREATE UNIQUE INDEX "Promocion_slug_key" ON "Promocion"("slug");

-- CreateIndex
CREATE INDEX "Promocion_estado_vigenteHasta_idx" ON "Promocion"("estado", "vigenteHasta");

-- CreateIndex
CREATE INDEX "Promocion_especialidadId_idx" ON "Promocion"("especialidadId");

-- CreateIndex
CREATE INDEX "Promocion_creadaPorId_idx" ON "Promocion"("creadaPorId");

-- CreateIndex
CREATE INDEX "Promocion_revisadaPorId_idx" ON "Promocion"("revisadaPorId");

-- CreateIndex
CREATE UNIQUE INDEX "PromocionImagen_promocionId_formato_key" ON "PromocionImagen"("promocionId", "formato");

-- CreateIndex
CREATE INDEX "PromocionAnuncio_promocionId_idx" ON "PromocionAnuncio"("promocionId");

-- CreateIndex
CREATE INDEX "PromocionMedico_perfilMedicoId_idx" ON "PromocionMedico"("perfilMedicoId");

-- AddForeignKey
ALTER TABLE "PerfilMedico" ADD CONSTRAINT "PerfilMedico_medicoId_fkey" FOREIGN KEY ("medicoId") REFERENCES "Medico"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerfilMedicoEspecialidad" ADD CONSTRAINT "PerfilMedicoEspecialidad_perfilMedicoId_fkey" FOREIGN KEY ("perfilMedicoId") REFERENCES "PerfilMedico"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerfilMedicoEspecialidad" ADD CONSTRAINT "PerfilMedicoEspecialidad_especialidadId_fkey" FOREIGN KEY ("especialidadId") REFERENCES "Especialidad"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HorarioMedico" ADD CONSTRAINT "HorarioMedico_perfilMedicoId_fkey" FOREIGN KEY ("perfilMedicoId") REFERENCES "PerfilMedico"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AusenciaMedico" ADD CONSTRAINT "AusenciaMedico_perfilMedicoId_fkey" FOREIGN KEY ("perfilMedicoId") REFERENCES "PerfilMedico"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Promocion" ADD CONSTRAINT "Promocion_especialidadId_fkey" FOREIGN KEY ("especialidadId") REFERENCES "Especialidad"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Promocion" ADD CONSTRAINT "Promocion_creadaPorId_fkey" FOREIGN KEY ("creadaPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Promocion" ADD CONSTRAINT "Promocion_revisadaPorId_fkey" FOREIGN KEY ("revisadaPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromocionImagen" ADD CONSTRAINT "PromocionImagen_promocionId_fkey" FOREIGN KEY ("promocionId") REFERENCES "Promocion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromocionAnuncio" ADD CONSTRAINT "PromocionAnuncio_promocionId_fkey" FOREIGN KEY ("promocionId") REFERENCES "Promocion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromocionMedico" ADD CONSTRAINT "PromocionMedico_promocionId_fkey" FOREIGN KEY ("promocionId") REFERENCES "Promocion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromocionMedico" ADD CONSTRAINT "PromocionMedico_perfilMedicoId_fkey" FOREIGN KEY ("perfilMedicoId") REFERENCES "PerfilMedico"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Reglas que sostiene la base aunque un camino nuevo se salte el service.
-- (Prisma no modela CHECK; se escriben a mano y `migrate diff` no las toca.)
ALTER TABLE "HorarioMedico"
  ADD CONSTRAINT "HorarioMedico_dia_chk" CHECK ("diaSemana" BETWEEN 1 AND 7),
  ADD CONSTRAINT "HorarioMedico_horas_chk" CHECK ("inicioMinuto" >= 0 AND "finMinuto" <= 1440 AND "inicioMinuto" < "finMinuto");

ALTER TABLE "AusenciaMedico"
  ADD CONSTRAINT "AusenciaMedico_rango_chk" CHECK ("desde" <= "hasta");

ALTER TABLE "PerfilMedico"
  ADD CONSTRAINT "PerfilMedico_precio_chk" CHECK ("precioConsulta" IS NULL OR "precioConsulta" >= 0);

ALTER TABLE "Promocion"
  ADD CONSTRAINT "Promocion_vigencia_chk" CHECK ("vigenteHasta" IS NULL OR "vigenteHasta" >= "vigenteDesde"),
  ADD CONSTRAINT "Promocion_precios_chk" CHECK (("precioRegular" IS NULL OR "precioRegular" >= 0) AND ("precioPromocional" IS NULL OR "precioPromocional" >= 0)),
  ADD CONSTRAINT "Promocion_rebaja_chk" CHECK ("precioRegular" IS NULL OR "precioPromocional" IS NULL OR "precioPromocional" < "precioRegular");

ALTER TABLE "PromocionImagen"
  ADD CONSTRAINT "PromocionImagen_medidas_chk" CHECK ("ancho" > 0 AND "alto" > 0 AND "bytes" > 0);
