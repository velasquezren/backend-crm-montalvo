-- Índices para el historial clínico.
--
-- El módulo de servicios agrupa por paciente y por médico sobre TODOS los
-- periodos, no dentro de uno. Los índices que ya existían empiezan por
-- `periodoId` (`periodoId, vendedoraId`, `periodoId, clasif`…) y por eso no
-- sirven para un `GROUP BY v."pac"` sin filtro de periodo.
--
-- Hoy son 1.287 filas y Postgres hace Seq Scan sin despeinarse, pero la tabla
-- suma unas 450 al mes: en dos años son 11.000 y cada apertura del historial
-- las recorrería enteras.
CREATE INDEX "VentaImportada_pac_idx"      ON "VentaImportada"("pac");
CREATE INDEX "VentaImportada_medicoPk_idx" ON "VentaImportada"("medicoPk");
