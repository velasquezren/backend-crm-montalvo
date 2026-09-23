-- `PeriodoComision_anio_mes_key` (único) ya indexa ("anio", "mes"); este índice
-- era idéntico y cada escritura lo mantenía dos veces.
DROP INDEX "PeriodoComision_anio_mes_idx";
