#!/bin/bash
# Crea el usuario MySQL `crm_agenda_consulta` (SOLO SELECT) que usa la pantalla
# Reservas del CRM para leer las reservas con los datos de la paciente y su
# comprobante. Lo ejecuta René en una terminal normal (pide la clave root de
# MySQL de montalvo-vps); la contraseña nueva va directo al .env del CRM y no se
# muestra. Requiere `clave-casa` cargada (ssh-add) y el alias `montalvo-vps`.
#
# La política validate_password de ese MySQL exige mayúscula, minúscula, número
# y símbolo; se usan solo «-» y «_» porque el .env se lee con `.` en el despliegue.
set -euo pipefail
P="Cq-$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 36)_4m"
[ ${#P} -ge 40 ] || { echo "No se pudo generar la contraseña"; exit 1; }
H="'107.175.132.15'"
{
cat <<SQL
CREATE USER IF NOT EXISTS 'crm_agenda_consulta'@$H IDENTIFIED BY '$P' REQUIRE SSL WITH MAX_USER_CONNECTIONS 4;
ALTER USER 'crm_agenda_consulta'@$H IDENTIFIED BY '$P';
GRANT SELECT (para_age, medico_pk, fecha, hora, nombre_age, telefono_age, ci_age, obs, estado, nom_med, fecha_registro, hora_registro, nit, razon_social, precio_con, comprobante) ON clinica.para_agendar TO 'crm_agenda_consulta'@$H;
GRANT SELECT (medico_pk, nombre, especialidad) ON clinica.medicos TO 'crm_agenda_consulta'@$H;
SHOW GRANTS FOR 'crm_agenda_consulta'@$H;
SELECT estado, COUNT(*) AS reservas FROM clinica.para_agendar GROUP BY estado;
SQL
} | ssh montalvo-vps 'umask 077; cat > /root/.agenda-consulta.sql'
echo "Escribe la contraseña de root de MySQL de montalvo-vps:"
ssh -tt montalvo-vps 'MYSQL_HISTFILE=/dev/null mysql --no-defaults -u root -p -e "source /root/.agenda-consulta.sql"; r=$?; shred -u /root/.agenda-consulta.sql; exit $r'
printf '%s\n' "$P" | ssh root@107.175.132.15 'read -r P; E=/opt/crm-backend/.env; sed -i "/^AGENDA_CONSULTA_PASSWORD=/d;/^AGENDA_CONSULTA_USUARIO=/d" "$E"; printf "AGENDA_CONSULTA_USUARIO=crm_agenda_consulta\nAGENDA_CONSULTA_PASSWORD=%s\n" "$P" >> "$E"'
unset P
echo "Listo: usuario de consulta creado y guardado en el .env del CRM (AGENDA_VPS_CONSULTA sigue apagado hasta desplegar)."
