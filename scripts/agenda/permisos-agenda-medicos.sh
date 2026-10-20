#!/bin/bash
# Permite a la cuenta de CONSULTA del CRM (`crm_agenda_consulta`, solo SELECT)
# armar la agenda de un médico para el asistente de WhatsApp: qué pacientes tiene
# en un día. Es la agenda REAL de la clínica: las citas que FileMaker escribe en
# `agenda_med` (estado CREADO) más las reservas todavía sin cargar de `para_agendar`.
#
# De `agenda_med` se lee código de médico, fecha, hora, estado, el NOMBRE de la
# paciente, la ACTIVIDAD y el SEGURO (lo que el médico ve en su pantalla de
# FileMaker): nunca su PAC, teléfono ni pago. De `medicos` solo
# el `codigo` (el vínculo con `agenda_med.cod_med`), que no es sensible. Ninguna
# escritura nueva. Las reservas (`para_agendar`) ya las lee con el permiso de la
# pantalla Reservas.
#
# Lo ejecuta René en una terminal normal (pide la clave root de MySQL de
# montalvo-vps). Requiere `clave-casa` cargada y el alias `montalvo-vps`.
# Ejecutarlo ANTES de activar el asistente para médicos; sin estos permisos la
# herramienta responde que no puede consultar la agenda y pasa a una persona.
# Volver a correrlo es seguro (GRANT suma). Si la actividad o el seguro tuvieran
# otro nombre de columna, el GRANT falla sin cambiar nada; la lista de columnas
# que imprime antes dice cuál es, y la agenda sigue saliendo sin ese renglón.
set -euo pipefail
H="'107.175.132.15'"
cat <<SQL | ssh montalvo-vps 'umask 077; cat > /root/.agenda-medicos.sql'
SELECT COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = 'clinica' AND TABLE_NAME = 'agenda_med' ORDER BY ORDINAL_POSITION;
GRANT SELECT (agendam_pk, cod_med, fecha, hora, estado, paciente, actividad, seguro) ON clinica.agenda_med TO 'crm_agenda_consulta'@$H;
GRANT SELECT (codigo) ON clinica.medicos TO 'crm_agenda_consulta'@$H;
SHOW GRANTS FOR 'crm_agenda_consulta'@$H;
SELECT estado, COUNT(*) AS citas_futuras FROM clinica.agenda_med WHERE fecha >= CURRENT_DATE() GROUP BY estado;
SQL
echo "Escribe la contraseña de root de MySQL de montalvo-vps:"
ssh -tt montalvo-vps 'MYSQL_HISTFILE=/dev/null mysql --no-defaults -u root -p -e "source /root/.agenda-medicos.sql"; r=$?; shred -u /root/.agenda-medicos.sql; exit $r'
echo "Listo: la cuenta de consulta ya puede leer las citas por médico (hora, nombre, actividad y seguro)."
