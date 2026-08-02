-- Qué valor de la columna `captacion` del Excel cuenta como venta propia.
--
-- Estaba hardcodeado en el clasificador, y es la diferencia entre pagar 4,5% y
-- 5,5% (o 1% y 2% en planes). Administración cambia los canales de captación sin
-- avisar, así que tiene que poder editarlo sin tocar código.
CREATE TABLE "MapeoCaptacion" (
    "valor" VARCHAR(60) NOT NULL,
    "canal" "CanalVenta" NOT NULL,

    CONSTRAINT "MapeoCaptacion_pkey" PRIMARY KEY ("valor")
);

-- Se siembra aquí y no solo desde `asegurarConfiguracion()` para que las
-- instalaciones que ya existen tengan la tabla poblada de inmediato: si quedara
-- vacía, TODA venta caería en EMPRESA hasta la siguiente importación.
--
-- FACEBOOK va a EMPRESA a propósito: en la planilla, un plan Gold vendido por
-- Facebook cobró 3%, que es la tarifa de empresa, no el 5% de propio.
INSERT INTO "MapeoCaptacion" ("valor", "canal") VALUES
    ('PROPIO',    'PROPIO'),
    ('REDES',     'PROPIO'),
    ('CLINICA',   'EMPRESA'),
    ('FACEBOOK',  'EMPRESA'),
    ('INSTAGRAM', 'EMPRESA');
