#!/usr/bin/env bash
# Respaldo externo nocturno a gs://crm-clinica-montalvo-respaldos (Google Cloud, us-east1).
#
# Complementa, no reemplaza, los respaldos locales (backup-crm.sh 03:15 y
# montalvo-resultados-backup 03:15): esos sirven si se rompe una base; este, si
# se pierde el VPS entero.
#
#   crm/diario/          volcado de la base del CRM + configuración (35 días)
#   resultados/diario/   volcado de la base de Resultados (35 días)
#   */mensual/           el primer volcado de cada mes (13 meses, en Archive)
#   resultados/archivos/ PDF y adjuntos de Resultados, ya cifrados por la app (incremental)
#   r2/                  copia de R2 (archivos del chat), cifrada con rclone (incremental)
#
# Los volcados y la configuración se cifran con `age` y la clave PÚBLICA: este
# servidor puede cifrar pero no descifrar. La clave privada y las contraseñas de
# rclone las guarda el dueño fuera del servidor.
#
# La cuenta de servicio solo puede crear y leer: no borra ni sobrescribe, y el
# bucket retiene todo 30 días. Lo viejo lo borra el ciclo de vida del bucket.
set -euo pipefail
umask 077

CONF=/etc/respaldos-externos
export RCLONE_CONFIG=$CONF/rclone.conf
BUCKET=gcs:crm-clinica-montalvo-respaldos
ENV_CRM=/opt/crm-backend/.env
ARCHIVOS_RESULTADOS=/var/lib/montalvo-resultados/files
ESTADO=/var/lib/respaldo-externo

# Corre como servicio: lo que se escribe aquí queda en `journalctl -u respaldo-externo`.
log() { echo "$*"; }
falla() { echo "FALLO: $*" >&2; exit 1; }

exec 9>/run/respaldo-externo.lock
flock -n 9 || falla "ya hay otro respaldo externo corriendo"

RECEPTOR=$(cat "$CONF/age-publica.txt")
[[ $RECEPTOR == age1* ]] || falla "clave pública de age inválida"

v() { sed -n "s/^$1=//p" "$ENV_CRM" | tr -d "\"'"; }
export RCLONE_CONFIG_R2_ACCESS_KEY_ID; RCLONE_CONFIG_R2_ACCESS_KEY_ID=$(v R2_ACCESS_KEY_ID)
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY; RCLONE_CONFIG_R2_SECRET_ACCESS_KEY=$(v R2_SECRET_ACCESS_KEY)
export RCLONE_CONFIG_R2_ENDPOINT; RCLONE_CONFIG_R2_ENDPOINT="https://$(v R2_ACCOUNT_ID).r2.cloudflarestorage.com"
R2_BUCKET=$(v R2_BUCKET)

rc() { nice -n 19 ionice -c3 rclone --retries 3 --low-level-retries 10 --stats 0 "$@"; }

TMP=$(mktemp -d /var/tmp/respaldo-externo.XXXXXX)
trap 'rm -rf "$TMP"' EXIT
SELLO=$(date -u +%Y%m%dT%H%M%SZ)
MES=$(date -u +%Y%m)

# Sube un archivo a <carpeta>/diario/ y, si es el primero del mes, también a <carpeta>/mensual/.
subir() {
  local archivo=$1 carpeta=$2 prefijo=$3 nombre
  nombre=$(basename "$archivo")
  rc copyto "$archivo" "$BUCKET/$carpeta/diario/$nombre"
  if [[ -z $(rc lsf "$BUCKET/$carpeta/mensual/" --include "$prefijo-$MES*" 2>/dev/null) ]]; then
    rc copyto "$archivo" "$BUCKET/$carpeta/mensual/$nombre"
    log "copia mensual: $carpeta/mensual/$nombre"
  fi
}

# Vuelca una base en formato custom, comprueba que pg_restore la lee y que no es
# sospechosamente chica, y la deja cifrada. El volcado en claro no sale de $TMP.
volcar() {
  local base=$1 prefijo=$2 minimo=$3 plano cifrado tam
  plano="$TMP/$prefijo-$SELLO.dump"
  cifrado="$plano.age"
  nice -n 19 ionice -c3 runuser -u postgres -- pg_dump -Fc -d "$base" > "$plano" || falla "pg_dump de $base"
  pg_restore --list "$plano" > /dev/null || falla "el volcado de $base no se puede leer"
  tam=$(stat -c%s "$plano")
  (( tam >= minimo )) || falla "volcado de $base sospechosamente chico ($tam bytes)"
  age -r "$RECEPTOR" -o "$cifrado" "$plano"
  shred -u "$plano"
  echo "$cifrado"
}

inicio=$(date +%s)

# 1. Bases de datos.
crm=$(volcar crm crm 1000000)
subir "$crm" crm crm
resultados=$(volcar resultados_prod resultados 50000)
subir "$resultados" resultados resultados

# 2. Configuración: sin ella no se descifran los PDF (STORAGE_ENCRYPTION_KEY) ni
#    se levanta nada. Cifrada con la misma clave pública.
config="$TMP/config-$SELLO.tar.age"
rutas=()
for r in opt/crm-backend/.env etc/montalvo-resultados etc/respaldos-externos/rclone.conf \
         etc/respaldos-externos/age-publica.txt etc/systemd/system/crm_backend.service \
         etc/systemd/system/resultados-api.service etc/systemd/system/resultados-worker.service \
         etc/systemd/system/resultados-portal.service etc/systemd/system/resultados-portal.service.d \
         etc/systemd/system/resultados-worker.service.d etc/apache2/sites-available etc/cron.d/backup-crm \
         usr/local/sbin; do
  [[ -e /$r ]] && rutas+=("$r")
done
tar -C / -cf - "${rutas[@]}" | age -r "$RECEPTOR" -o "$config"
subir "$config" crm config

# 3. PDF y adjuntos de Resultados: ya cifrados por la app (MNTV1/MNTV2) y con
#    nombre único, así que basta subir los nuevos.
rc copy "$ARCHIVOS_RESULTADOS" "$BUCKET/resultados/archivos" --ignore-existing
rc check "$ARCHIVOS_RESULTADOS" "$BUCKET/resultados/archivos" --one-way --size-only 2> "$TMP/check-archivos.log" \
  || { tail -5 "$TMP/check-archivos.log" >&2; falla "faltan archivos de Resultados en el bucket"; }

# 4. R2 (fotos, audios y documentos del chat), cifrado por rclone en r2/.
rc copy "r2:$R2_BUCKET" r2cifrado: --ignore-existing --fast-list
rc check "r2:$R2_BUCKET" r2cifrado: --one-way --size-only 2> "$TMP/check-r2.log" \
  || { tail -5 "$TMP/check-r2.log" >&2; falla "faltan archivos de R2 en el bucket"; }

mkdir -p "$ESTADO"
date -u +%FT%TZ > "$ESTADO/ultimo-ok"
log "OK en $(( $(date +%s) - inicio )) s: crm $(( $(stat -c%s "$crm") / 1024 )) KB, resultados $(( $(stat -c%s "$resultados") / 1024 )) KB, config $(( $(stat -c%s "$config") / 1024 )) KB, archivos y R2 al día"
