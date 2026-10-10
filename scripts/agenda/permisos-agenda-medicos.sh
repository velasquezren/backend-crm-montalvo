#!/bin/bash
# Permite a la cuenta de CONSULTA del CRM (`crm_agenda_consulta`, solo SELECT)
# armar la agenda de un médico para el asistente de WhatsApp: qué pacientes tiene
# en un día. Es la agenda REAL de la clínica: las citas que FileMaker escribe en
# `agenda_med` (estado CREADO) más las reservas todavía sin cargar de `para_agendar`.
#
# De `agenda_med` se lee código de médico, fecha, hora, estado y el NOMBRE de la
# paciente: nunca su PAC, teléfono, seguro, actividad ni pago. De `medicos` solo
# el `codigo` (el vínculo con `agenda_med.cod_med`), que no es sensible. Ninguna
# escritura nueva. Las reservas (`para_agendar`) ya las lee con el permiso de la
# pantalla Reservas.
#
# Lo ejecuta René en una terminal normal (pide la clave root de MySQL de
# montalvo-vps). Requiere `clave-casa` cargada y el alias `montalvo-vps`.
# Ejecutarlo ANTES de activar el asistente para médicos; sin estos permisos la
# herramienta responde que no puede consultar la agenda y pasa a una persona.
set -euo pipefail
H="'107.175.132.15'"
cat <<SQL | ssh montalvo-vps 'umask 077; cat > /root/.agenda-medicos.sql'
GRANT SELECT (agendam_pk, cod_med, fecha, hora, estado, paciente) ON clinica.agenda_med TO 'crm_agenda_consulta'@$H;
GRANT SELECT (codigo) ON clinica.medicos TO 'crm_agenda_consulta'@$H;
SHOW GRANTS FOR 'crm_agenda_consulta'@$H;
SELECT estado, COUNT(*) AS citas_futuras FROM clinica.agenda_med WHERE fecha >= CURRENT_DATE() GROUP BY estado;
SQL
echo "Escribe la contraseña de root de MySQL de montalvo-vps:"
ssh -tt montalvo-vps 'MYSQL_HISTFILE=/dev/null mysql --no-defaults -u root -p -e "source /root/.agenda-medicos.sql"; r=$?; shred -u /root/.agenda-medicos.sql; exit $r'
echo "Listo: la cuenta de consulta ya puede leer las citas por médico (solo hora y nombre)."
