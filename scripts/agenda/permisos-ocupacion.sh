#!/bin/bash
# Permite a las cuentas de LECTURA pública y de RESERVAS del CRM calcular las
# horas libres como la agenda que ve el médico: solo ocupan las citas vigentes
# (`agenda_med.estado = 'CREADO'`) y las reservas web PENDIENTE/PAGADO. Con la
# vista de ScriptCase, una cita anulada (BORRADO) o cambiada de hora
# (MODIFICADO) dejaba su hora ocupada para siempre.
#
# De `agenda_med` solo se lee código de médico, fecha, hora y estado: nunca la
# paciente, su teléfono, PAC ni pago. Ninguna escritura nueva.
#
# Lo ejecuta René en una terminal normal (pide la clave root de MySQL de
# montalvo-vps). Requiere `clave-casa` cargada y el alias `montalvo-vps`.
# Ejecutarlo ANTES de desplegar el backend que usa `horasLibres`.
set -euo pipefail
H="'107.175.132.15'"
cat <<SQL | ssh montalvo-vps 'umask 077; cat > /root/.agenda-ocupacion.sql'
GRANT SELECT (medico_pk, dia, hora, estado, cod_med) ON clinica.horarios TO 'crm_agenda_lectura'@$H;
GRANT SELECT (cod_med, fecha, hora, estado) ON clinica.agenda_med TO 'crm_agenda_lectura'@$H;
GRANT SELECT (medico_pk, dia, hora, estado, cod_med) ON clinica.horarios TO 'crm_agenda_reserva'@$H;
GRANT SELECT (cod_med, fecha, hora, estado) ON clinica.agenda_med TO 'crm_agenda_reserva'@$H;
SHOW GRANTS FOR 'crm_agenda_lectura'@$H;
SHOW GRANTS FOR 'crm_agenda_reserva'@$H;
SELECT estado, COUNT(*) AS citas_futuras FROM clinica.agenda_med WHERE fecha >= CURRENT_DATE() GROUP BY estado;
SQL
echo "Escribe la contraseña de root de MySQL de montalvo-vps:"
ssh -tt montalvo-vps 'MYSQL_HISTFILE=/dev/null mysql --no-defaults -u root -p -e "source /root/.agenda-ocupacion.sql"; r=$?; shred -u /root/.agenda-ocupacion.sql; exit $r'
echo "Listo: las cuentas de lectura y reservas ya pueden ver qué citas están vigentes."
