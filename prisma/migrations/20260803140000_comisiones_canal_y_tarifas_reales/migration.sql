-- Ajustes de configuración verificados contra la planilla real de administración
-- ("CALCULO COMISION DICIEMBRE 2024.xlsx"). Son datos, no estructura: por eso
-- van con UPDATE/INSERT y no tocan ninguna tabla.

/* ── 1. Canal de venta ────────────────────────────────────────────────────
   `Hoja1 (2)`, fila 24, definición escrita por administración:
   «Se considera RE cualquier contacto generado con recursos de la empresa,
    por ejemplo: pacientes de clínica, RRSS, ferias, brunch de mamás…»
   REDES son las RRSS de la clínica y RAMADA/EXPOBEBE son ferias: todas EMPRESA.
   Estaban como PROPIO, que paga 5,5 % en vez de 4,5 % y 5 % en vez de 3 %. */
UPDATE "MapeoCaptacion" SET canal = 'EMPRESA' WHERE valor = 'REDES';

INSERT INTO "MapeoCaptacion" (valor, canal) VALUES
  ('PROPIA',    'PROPIO'),
  ('RAMADA',    'EMPRESA'),
  ('EXPOBEBE',  'EMPRESA'),
  ('EXPO BEBE', 'EMPRESA')
ON CONFLICT (valor) DO NOTHING;

/* ── 2. Laboratorios de RA ────────────────────────────────────────────────
   `Parametro RA`, filas 53-54: LAboratoriosCLINICA 0,01 y LAboratoriosPROPIA
   0,01. No se les aplica la regla del ÷0,7; el propio estaba en 1,43 %. */
UPDATE "TarifaRA" SET "montoPropio" = 1.0 WHERE procedimiento = 'Laboratorios RA (Etapa I)';

/* ── 3. Cirugía bariátrica ────────────────────────────────────────────────
   En la planilla «Manga Gastrica» y «By Pass Gastrico» están clasificados
   CIRUGIA (Tipo B) aunque la columna de origen los llame «Paquete». Estaban
   entrando como PLANNIN, o sea Tipo A y contando para el objetivo de planes. */
UPDATE "ReglaClasificacion"
   SET clasif = 'CIRUGIA', prioridad = 30,
       notas  = 'Cirugia bariatrica (Tipo B), pese a venir como paquete'
 WHERE patron = 'Paquete Bariatrica';

INSERT INTO "ReglaClasificacion" (id, patron, exacto, modulo, clasif, nivel, "unidadNegocio", prioridad, activa, notas, "createdAt", "updatedAt")
VALUES
  (gen_random_uuid(), 'Manga Gastrica',   false, NULL, 'CIRUGIA', NULL, 'VARIOS', 30, true, 'Cirugia bariatrica', NOW(), NOW()),
  (gen_random_uuid(), 'By Pass Gastrico', false, NULL, 'CIRUGIA', NULL, 'VARIOS', 30, true, 'Cirugia bariatrica', NOW(), NOW());
