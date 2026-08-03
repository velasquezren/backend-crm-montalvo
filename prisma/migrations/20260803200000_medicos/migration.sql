-- Los médicos como entidad propia, no como texto repetido en cada venta.
-- Se identifican por `codigo` (medico_pk de FileMaker), la misma clave que usan
-- Usuario y VendedoraComision: FileMaker identifica a la PERSONA, no al rol.
CREATE TABLE "Medico" (
    "id"           TEXT         NOT NULL,
    "codigo"       VARCHAR(40)  NOT NULL,
    "nombre"       VARCHAR(200) NOT NULL,
    "especialidad" VARCHAR(120),
    "activo"       BOOLEAN      NOT NULL DEFAULT true,
    "configurado"  BOOLEAN      NOT NULL DEFAULT false,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Medico_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Medico_codigo_key" ON "Medico"("codigo");
CREATE INDEX "Medico_activo_idx"        ON "Medico"("activo");
