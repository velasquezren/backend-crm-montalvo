-- Planilla de comisiones: metas por mes, bono de publicidad y captación editable.
--
-- Las tablas afectadas se RECREAN en vez de irles agregando columnas al final.
-- Se puede porque ninguna guarda información que no sea reproducible:
--   · ResultadoComision se regenera con "Calcular" del periodo.
--   · ObjetivoComision son las metas base, que se siembran solas.
-- Las tablas con trabajo real de administración (ReglaClasificacion, tarifas,
-- parámetros, vendedoras) NO se tocan.
--
-- Recrear en vez de ALTER deja las columnas agrupadas por tema —identidad,
-- Tipo A, Tipo B, comisiones, bonos, totales— en vez del orden accidental en
-- que fueron apareciendo. Un `SELECT *` vuelve a ser legible.

/* ── 1. Metas: dos capas (por defecto y propias de un mes) ──────────────── */

DROP TABLE IF EXISTS "ObjetivoComision";

CREATE TABLE "ObjetivoComision" (
    "id"                 TEXT            NOT NULL,
    "tipo"               "TipoVendedora" NOT NULL,
    -- NULL = meta por defecto; con periodo = meta propia de ese mes.
    "periodoId"          TEXT,

    "planpaqMinimos"     INTEGER         NOT NULL,
    "planninMinimos"     INTEGER         NOT NULL DEFAULT 1,
    "montoMensualUsd"    DECIMAL(12,2)   NOT NULL,
    "montoTrimestralUsd" DECIMAL(12,2)   NOT NULL,

    CONSTRAINT "ObjetivoComision_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ObjetivoComision_periodoId_idx" ON "ObjetivoComision"("periodoId");
CREATE UNIQUE INDEX "ObjetivoComision_tipo_periodoId_key" ON "ObjetivoComision"("tipo", "periodoId");

-- En Postgres dos NULL no son iguales entre sí, así que el único de arriba NO
-- impide dos filas "por defecto" del mismo tipo, y entonces cuál gana dependería
-- del orden de lectura. Este índice parcial lo cierra. Prisma no puede expresar
-- un WHERE, así que vive solo aquí.
CREATE UNIQUE INDEX "ObjetivoComision_tipo_defecto_key"
    ON "ObjetivoComision"("tipo") WHERE "periodoId" IS NULL;

ALTER TABLE "ObjetivoComision" ADD CONSTRAINT "ObjetivoComision_periodoId_fkey"
    FOREIGN KEY ("periodoId") REFERENCES "PeriodoComision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

/* ── 2. Resultado por vendedora, con las columnas agrupadas por tema ────── */

DROP TABLE IF EXISTS "ResultadoComision";

CREATE TABLE "ResultadoComision" (
    "id"                   TEXT          NOT NULL,
    "periodoId"            TEXT          NOT NULL,
    "vendedoraId"          TEXT          NOT NULL,

    -- Lo vendido
    "montoVendido"         DECIMAL(14,2) NOT NULL DEFAULT 0,
    "baseCalculo"          DECIMAL(14,2) NOT NULL DEFAULT 0,

    -- Tipo A · planes (solo comisionan los que superan el objetivo)
    "planpaqVendidos"      INTEGER       NOT NULL DEFAULT 0,
    "planpaqComisionables" INTEGER       NOT NULL DEFAULT 0,
    "planninVendidos"      INTEGER       NOT NULL DEFAULT 0,
    "planninComisionables" INTEGER       NOT NULL DEFAULT 0,
    "planesVendidos"       INTEGER       NOT NULL DEFAULT 0,
    "cumpleObjetivoPlanes" BOOLEAN       NOT NULL DEFAULT false,

    -- Tipo B · cirugías
    "acumuladoCirugias"    DECIMAL(14,2) NOT NULL DEFAULT 0,
    "nivelCirugia"         INTEGER,

    -- Comisiones (USD)
    "comisionA"            DECIMAL(12,2) NOT NULL DEFAULT 0,
    "comisionB"            DECIMAL(12,2) NOT NULL DEFAULT 0,
    "comisionC"            DECIMAL(12,2) NOT NULL DEFAULT 0,

    -- Bonos (USD)
    "bonoJefatura"         DECIMAL(12,2) NOT NULL DEFAULT 0,
    "bonoPublicidad"       DECIMAL(12,2) NOT NULL DEFAULT 0,
    "bonoTrimestral"       DECIMAL(12,2) NOT NULL DEFAULT 0,

    -- Totales
    "totalUsd"             DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalBob"             DECIMAL(12,2) NOT NULL DEFAULT 0,
    "sueldoBase"           DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalGanado"          DECIMAL(12,2) NOT NULL DEFAULT 0,

    "desglose"             JSONB,
    "createdAt"            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResultadoComision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ResultadoComision_periodoId_vendedoraId_key"
    ON "ResultadoComision"("periodoId", "vendedoraId");
CREATE INDEX "ResultadoComision_periodoId_idx" ON "ResultadoComision"("periodoId");

ALTER TABLE "ResultadoComision" ADD CONSTRAINT "ResultadoComision_periodoId_fkey"
    FOREIGN KEY ("periodoId") REFERENCES "PeriodoComision"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResultadoComision" ADD CONSTRAINT "ResultadoComision_vendedoraId_fkey"
    FOREIGN KEY ("vendedoraId") REFERENCES "VendedoraComision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

/* ── 3. Captación: qué cuenta como venta propia ─────────────────────────── */

-- Estaba hardcodeado en el clasificador, y es la diferencia entre pagar 4,5% y
-- 5,5%. Los canales cambian sin avisar, así que administración debe poder
-- tocarlo sin pasar por un despliegue.
CREATE TABLE "MapeoCaptacion" (
    "valor" VARCHAR(60) NOT NULL,
    "canal" "CanalVenta" NOT NULL,

    CONSTRAINT "MapeoCaptacion_pkey" PRIMARY KEY ("valor")
);

-- Se siembra aquí y no solo desde `asegurarConfiguracion()` porque si la tabla
-- quedara vacía TODA venta caería en EMPRESA hasta la siguiente importación.
-- FACEBOOK va a EMPRESA a propósito: en la planilla, un plan Gold vendido por
-- Facebook cobró 3%, que es la tarifa de empresa, no el 5% de propio.
INSERT INTO "MapeoCaptacion" ("valor", "canal") VALUES
    ('PROPIO',    'PROPIO'),
    ('REDES',     'PROPIO'),
    ('CLINICA',   'EMPRESA'),
    ('FACEBOOK',  'EMPRESA'),
    ('INSTAGRAM', 'EMPRESA');
