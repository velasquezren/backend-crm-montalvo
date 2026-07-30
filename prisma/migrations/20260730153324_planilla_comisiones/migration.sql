-- CreateEnum
CREATE TYPE "CanalVenta" AS ENUM ('EMPRESA', 'PROPIO');

-- CreateEnum
CREATE TYPE "UnidadNegocio" AS ENUM ('MATERNIDAD', 'RA', 'VARIOS');

-- CreateEnum
CREATE TYPE "ClasifComision" AS ENUM ('PLANPAQ', 'PLANNIN', 'CIRUGIA', 'CONSULTA', 'LAB', 'ECOGRAFIA', 'OTROSS', 'CAMPANA', 'PROMOCION');

-- CreateEnum
CREATE TYPE "TipoComision" AS ENUM ('A', 'B', 'C');

-- CreateEnum
CREATE TYPE "NivelPlan" AS ENUM ('BRONCE', 'SILVER', 'GOLD');

-- CreateEnum
CREATE TYPE "TipoVendedora" AS ENUM ('JEFA', 'VENDEDORA');

-- CreateEnum
CREATE TYPE "AreaVendedora" AS ENUM ('EJECUTIVA', 'RA', 'PUBLICIDAD');

-- CreateEnum
CREATE TYPE "EstadoPeriodo" AS ENUM ('BORRADOR', 'CALCULADO', 'CERRADO');

-- CreateTable
CREATE TABLE "PeriodoComision" (
    "id" TEXT NOT NULL,
    "anio" INTEGER NOT NULL,
    "mes" INTEGER NOT NULL,
    "tipoCambio" DECIMAL(10,4) NOT NULL,
    "estado" "EstadoPeriodo" NOT NULL DEFAULT 'BORRADOR',
    "archivoNombre" VARCHAR(255),
    "filasTotales" INTEGER NOT NULL DEFAULT 0,
    "filasValidas" INTEGER NOT NULL DEFAULT 0,
    "importadoPor" TEXT,
    "calculadoEn" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PeriodoComision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VentaImportada" (
    "id" TEXT NOT NULL,
    "periodoId" TEXT NOT NULL,
    "fecha" TIMESTAMP(3),
    "modulo" VARCHAR(40),
    "codOrigen" VARCHAR(40),
    "estadoPlan" VARCHAR(40),
    "codItem" VARCHAR(40),
    "detalle" VARCHAR(300) NOT NULL,
    "pac" VARCHAR(40),
    "paciente" VARCHAR(200),
    "medicoPk" VARCHAR(40),
    "medico" VARCHAR(200),
    "vendedoraPk" VARCHAR(40),
    "vendedoraNombre" VARCHAR(200),
    "captacion" VARCHAR(40),
    "seguro" VARCHAR(60),
    "promocion" VARCHAR(20),
    "precio" DECIMAL(12,2) NOT NULL,
    "anticipoPlan" DECIMAL(12,2),
    "tc" DECIMAL(10,4),
    "obs" TEXT,
    "clasificacionPlan" VARCHAR(80),
    "canal" "CanalVenta" NOT NULL,
    "ingresoNeto" DECIMAL(12,2) NOT NULL,
    "unidadNegocio" "UnidadNegocio" NOT NULL,
    "clasif" "ClasifComision" NOT NULL,
    "tipo" "TipoComision" NOT NULL,
    "nivel" "NivelPlan",
    "comisionable" BOOLEAN NOT NULL DEFAULT true,
    "motivoExclusion" VARCHAR(200),
    "ajustadaManual" BOOLEAN NOT NULL DEFAULT false,
    "vendedoraId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VentaImportada_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendedoraComision" (
    "id" TEXT NOT NULL,
    "codigo" VARCHAR(40) NOT NULL,
    "nombre" VARCHAR(200) NOT NULL,
    "tipo" "TipoVendedora" NOT NULL DEFAULT 'VENDEDORA',
    "area" "AreaVendedora" NOT NULL DEFAULT 'EJECUTIVA',
    "sueldoBase" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "configurada" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendedoraComision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReglaClasificacion" (
    "id" TEXT NOT NULL,
    "patron" VARCHAR(200) NOT NULL,
    "exacto" BOOLEAN NOT NULL DEFAULT false,
    "modulo" VARCHAR(40),
    "clasif" "ClasifComision" NOT NULL,
    "nivel" "NivelPlan",
    "unidadNegocio" "UnidadNegocio",
    "prioridad" INTEGER NOT NULL DEFAULT 100,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "notas" VARCHAR(300),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReglaClasificacion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TarifaPlan" (
    "id" TEXT NOT NULL,
    "clave" VARCHAR(20) NOT NULL,
    "pctEmpresa" DECIMAL(6,3) NOT NULL,
    "pctPropio" DECIMAL(6,3) NOT NULL,

    CONSTRAINT "TarifaPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TarifaServicio" (
    "id" TEXT NOT NULL,
    "clasif" "ClasifComision" NOT NULL,
    "pctEmpresa" DECIMAL(6,3) NOT NULL,
    "pctPropio" DECIMAL(6,3) NOT NULL,

    CONSTRAINT "TarifaServicio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NivelCirugia" (
    "id" TEXT NOT NULL,
    "nivel" INTEGER NOT NULL,
    "montoDesde" DECIMAL(12,2) NOT NULL,
    "montoHasta" DECIMAL(12,2) NOT NULL,
    "pctEmpresa" DECIMAL(6,3) NOT NULL,
    "pctPropio" DECIMAL(6,3) NOT NULL,

    CONSTRAINT "NivelCirugia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TarifaRA" (
    "id" TEXT NOT NULL,
    "procedimiento" VARCHAR(120) NOT NULL,
    "montoEmpresa" DECIMAL(12,2) NOT NULL,
    "montoPropio" DECIMAL(12,2) NOT NULL,
    "esPorcentaje" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "TarifaRA_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ObjetivoComision" (
    "id" TEXT NOT NULL,
    "tipo" "TipoVendedora" NOT NULL,
    "planesMinimos" INTEGER NOT NULL,
    "montoMensualUsd" DECIMAL(12,2) NOT NULL,
    "montoTrimestralUsd" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "ObjetivoComision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ParametroComision" (
    "clave" VARCHAR(60) NOT NULL,
    "valor" DECIMAL(12,6) NOT NULL,
    "descripcion" VARCHAR(300),

    CONSTRAINT "ParametroComision_pkey" PRIMARY KEY ("clave")
);

-- CreateTable
CREATE TABLE "ResultadoComision" (
    "id" TEXT NOT NULL,
    "periodoId" TEXT NOT NULL,
    "vendedoraId" TEXT NOT NULL,
    "montoVendido" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "baseCalculo" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "planesVendidos" INTEGER NOT NULL DEFAULT 0,
    "cumpleObjetivoPlanes" BOOLEAN NOT NULL DEFAULT false,
    "acumuladoCirugias" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "nivelCirugia" INTEGER,
    "comisionA" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "comisionB" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "comisionC" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "bonoJefatura" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "bonoTrimestral" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalUsd" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalBob" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "sueldoBase" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalGanado" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "desglose" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResultadoComision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PeriodoComision_anio_mes_idx" ON "PeriodoComision"("anio", "mes");

-- CreateIndex
CREATE UNIQUE INDEX "PeriodoComision_anio_mes_key" ON "PeriodoComision"("anio", "mes");

-- CreateIndex
CREATE INDEX "VentaImportada_periodoId_idx" ON "VentaImportada"("periodoId");

-- CreateIndex
CREATE INDEX "VentaImportada_periodoId_vendedoraId_idx" ON "VentaImportada"("periodoId", "vendedoraId");

-- CreateIndex
CREATE INDEX "VentaImportada_periodoId_clasif_idx" ON "VentaImportada"("periodoId", "clasif");

-- CreateIndex
CREATE INDEX "VentaImportada_periodoId_comisionable_idx" ON "VentaImportada"("periodoId", "comisionable");

-- CreateIndex
CREATE UNIQUE INDEX "VendedoraComision_codigo_key" ON "VendedoraComision"("codigo");

-- CreateIndex
CREATE INDEX "VendedoraComision_activa_idx" ON "VendedoraComision"("activa");

-- CreateIndex
CREATE INDEX "ReglaClasificacion_activa_prioridad_idx" ON "ReglaClasificacion"("activa", "prioridad");

-- CreateIndex
CREATE UNIQUE INDEX "TarifaPlan_clave_key" ON "TarifaPlan"("clave");

-- CreateIndex
CREATE UNIQUE INDEX "TarifaServicio_clasif_key" ON "TarifaServicio"("clasif");

-- CreateIndex
CREATE UNIQUE INDEX "NivelCirugia_nivel_key" ON "NivelCirugia"("nivel");

-- CreateIndex
CREATE UNIQUE INDEX "TarifaRA_procedimiento_key" ON "TarifaRA"("procedimiento");

-- CreateIndex
CREATE UNIQUE INDEX "ObjetivoComision_tipo_key" ON "ObjetivoComision"("tipo");

-- CreateIndex
CREATE INDEX "ResultadoComision_periodoId_idx" ON "ResultadoComision"("periodoId");

-- CreateIndex
CREATE UNIQUE INDEX "ResultadoComision_periodoId_vendedoraId_key" ON "ResultadoComision"("periodoId", "vendedoraId");

-- AddForeignKey
ALTER TABLE "VentaImportada" ADD CONSTRAINT "VentaImportada_periodoId_fkey" FOREIGN KEY ("periodoId") REFERENCES "PeriodoComision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VentaImportada" ADD CONSTRAINT "VentaImportada_vendedoraId_fkey" FOREIGN KEY ("vendedoraId") REFERENCES "VendedoraComision"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResultadoComision" ADD CONSTRAINT "ResultadoComision_periodoId_fkey" FOREIGN KEY ("periodoId") REFERENCES "PeriodoComision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResultadoComision" ADD CONSTRAINT "ResultadoComision_vendedoraId_fkey" FOREIGN KEY ("vendedoraId") REFERENCES "VendedoraComision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
