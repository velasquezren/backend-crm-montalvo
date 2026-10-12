#!/bin/bash
# Un índice en `clinica.agenda_med` (las citas que escribe FileMaker) para que
# las consultas por día y por médico dejen de recorrer la tabla entera.
#
# Medido el 12/10/2026 con EXPLAIN desde el CRM: `agenda_med` tiene 14.627 citas
# (desde marzo de 2026, ~2.000 por mes) y SOLO su clave primaria, así que la
# disponibilidad de la web, la reserva por WhatsApp y la agenda del médico hacen
# `type: ALL` sobre todas las filas en cada consulta. ScriptCase, que lista la
# agenda por día, paga lo mismo.
#
# Qué NO cambia: ningún dato, ninguna columna, ningún resultado. Un índice es una
# estructura aparte que MySQL mantiene sola: FileMaker (ODBC) y ScriptCase leen y
# escriben igual que antes. Se crea EN LÍNEA (InnoDB, MySQL 8.0.44:
# ALGORITHM=INPLACE, LOCK=NONE): nadie queda bloqueado mientras se construye
# (segundos con este tamaño).
#
# (fecha, cod_med, estado): sirve a la vista por día de ScriptCase (fecha), a la
# agenda de un médico en un día (fecha + cod_med) y a la disponibilidad de los
# próximos 30 días (rango de fecha filtrando cod_med en el índice).
#
# Es idempotente: si el índice ya existe, no hace nada. Muestra el plan antes y
# después. Para quitarlo (no hace falta, pero por si acaso):
#   ALTER TABLE clinica.agenda_med DROP INDEX idx_agenda_med_fecha_medico, ALGORITHM=INPLACE, LOCK=NONE;
#
# Lo ejecuta René en una terminal normal (pide la clave root de MySQL de
# montalvo-vps). Requiere `clave-casa` cargada y el alias `montalvo-vps`.
set -euo pipefail
cat <<'SQL' | ssh montalvo-vps 'umask 077; cat > /root/.indice-agenda.sql'
SELECT 'ANTES' AS momento;
EXPLAIN SELECT cod_med, fecha, hora FROM clinica.agenda_med
 WHERE estado = 'CREADO' AND fecha BETWEEN CURRENT_DATE() AND CURRENT_DATE() + INTERVAL 30 DAY;
SET @existe := (SELECT COUNT(*) FROM information_schema.STATISTICS
                 WHERE TABLE_SCHEMA = 'clinica' AND TABLE_NAME = 'agenda_med' AND INDEX_NAME = 'idx_agenda_med_fecha_medico');
SET @sql := IF(@existe = 0,
  'ALTER TABLE clinica.agenda_med ADD INDEX idx_agenda_med_fecha_medico (fecha, cod_med, estado), ALGORITHM=INPLACE, LOCK=NONE',
  'SELECT ''El índice ya existía: no se cambió nada'' AS aviso');
PREPARE paso FROM @sql;
EXECUTE paso;
DEALLOCATE PREPARE paso;
SELECT 'DESPUES' AS momento;
EXPLAIN SELECT cod_med, fecha, hora FROM clinica.agenda_med
 WHERE estado = 'CREADO' AND fecha BETWEEN CURRENT_DATE() AND CURRENT_DATE() + INTERVAL 30 DAY;
SHOW INDEX FROM clinica.agenda_med;
SELECT COUNT(*) AS citas FROM clinica.agenda_med;
SQL
echo "Escribe la contraseña de root de MySQL de montalvo-vps:"
ssh -tt montalvo-vps 'MYSQL_HISTFILE=/dev/null mysql --no-defaults -u root -p -e "source /root/.indice-agenda.sql"; r=$?; shred -u /root/.indice-agenda.sql; exit $r'
echo "Listo: en DESPUES el plan debe decir key = idx_agenda_med_fecha_medico (antes: type ALL, sin key)."
