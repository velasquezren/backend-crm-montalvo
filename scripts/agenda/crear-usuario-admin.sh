#!/bin/bash
# Crea el usuario MySQL `crm_agenda_admin` con el que el Directorio del CRM
# administra médicos, horarios y especialidades de la agenda. Puede lo mismo que
# los formularios `form_medicos` y `form_horarios` de ScriptCase, MENOS: borrar,
# cambiar el código de FileMaker de un médico ya creado, ver o cambiar su
# login/contraseña, y tocar reservas o pacientes.
#
# Antes de crear el usuario deja un respaldo de `medicos`, `horarios` y
# `pagos_qr` en /root/respaldos-agenda/ de montalvo-vps (la agenda no tiene
# respaldos automáticos). Por eso pide DOS veces la clave root de MySQL.
#
# Lo ejecuta René en una terminal normal; la contraseña nueva va directo al .env
# del CRM y no se muestra. Requiere `clave-casa` cargada (ssh-add) y el alias
# `montalvo-vps`. La política validate_password exige mayúscula, minúscula,
# número y símbolo; se usan solo «-» y «_» porque el .env se lee con `.`.
set -euo pipefail
P="Ad-$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 36)_7m"
[ ${#P} -ge 40 ] || { echo "No se pudo generar la contraseña"; exit 1; }
H="'107.175.132.15'"
{
cat <<SQL
CREATE USER IF NOT EXISTS 'crm_agenda_admin'@$H IDENTIFIED BY '$P' REQUIRE SSL WITH MAX_USER_CONNECTIONS 3;
ALTER USER 'crm_agenda_admin'@$H IDENTIFIED BY '$P';
GRANT SELECT (medico_pk, codigo, nombre, sigla, especialidad, telefono, estado, horario_html, orden, precio_con, banco, foto) ON clinica.medicos TO 'crm_agenda_admin'@$H;
GRANT INSERT (medico_pk, codigo, nombre, sigla, especialidad, telefono, estado, horario_html, orden, precio_con, banco) ON clinica.medicos TO 'crm_agenda_admin'@$H;
GRANT UPDATE (nombre, sigla, especialidad, telefono, estado, horario_html, orden, precio_con, banco) ON clinica.medicos TO 'crm_agenda_admin'@$H;
GRANT SELECT (id_hora, medico_pk, cod_med, dia, hora, estado) ON clinica.horarios TO 'crm_agenda_admin'@$H;
GRANT INSERT (hora, orden, dia, medico_pk, cod_med, estado) ON clinica.horarios TO 'crm_agenda_admin'@$H;
GRANT UPDATE (estado) ON clinica.horarios TO 'crm_agenda_admin'@$H;
GRANT SELECT (qr_pk, banco, fecha_vence) ON clinica.pagos_qr TO 'crm_agenda_admin'@$H;
SHOW GRANTS FOR 'crm_agenda_admin'@$H;
SELECT estado, COUNT(*) AS medicos FROM clinica.medicos GROUP BY estado;
SQL
} | ssh montalvo-vps 'umask 077; cat > /root/.agenda-admin.sql'
echo "1/2 Respaldo de medicos, horarios y pagos_qr. Escribe la contraseña de root de MySQL de montalvo-vps:"
ssh -tt montalvo-vps 'umask 077; mkdir -p /root/respaldos-agenda; F=/root/respaldos-agenda/directorio-$(date +%Y%m%d-%H%M%S).sql; mysqldump --no-defaults -u root -p --single-transaction clinica medicos horarios pagos_qr > "$F" && [ -s "$F" ] && ls -la "$F" || { rm -f "$F" /root/.agenda-admin.sql; echo "Respaldo fallido: no se creó el usuario"; exit 1; }'
echo "2/2 Usuario de administración. Escribe otra vez la contraseña de root de MySQL:"
ssh -tt montalvo-vps 'MYSQL_HISTFILE=/dev/null mysql --no-defaults -u root -p -e "source /root/.agenda-admin.sql"; r=$?; shred -u /root/.agenda-admin.sql; exit $r'
printf '%s\n' "$P" | ssh root@107.175.132.15 'read -r P; E=/opt/crm-backend/.env; sed -i "/^AGENDA_ADMIN_PASSWORD=/d;/^AGENDA_ADMIN_USUARIO=/d" "$E"; printf "AGENDA_ADMIN_USUARIO=crm_agenda_admin\nAGENDA_ADMIN_PASSWORD=%s\n" "$P" >> "$E"'
unset P
echo "Listo: respaldo hecho, usuario de administración creado y guardado en el .env del CRM (AGENDA_VPS_ADMIN sigue apagado hasta desplegar)."
