-- Ejecutar como administrador MySQL, con respaldo previo de medicos y horarios.
-- Aditiva e idempotente; los médicos existentes conservan 30 minutos.
-- Las credenciales limitadas del CRM no tienen ALTER.
SET @existe_duracion = (SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = 'clinica' AND table_name = 'medicos' AND column_name = 'minutos_consulta');
SET @sql_duracion = IF(@existe_duracion = 0,
  'ALTER TABLE clinica.medicos ADD COLUMN minutos_consulta TINYINT UNSIGNED NOT NULL DEFAULT 30, ADD CONSTRAINT ck_medicos_minutos_consulta CHECK (minutos_consulta IN (15,30))',
  'SELECT 1');
PREPARE migrar_duracion FROM @sql_duracion;
EXECUTE migrar_duracion;
DEALLOCATE PREPARE migrar_duracion;
