set -euo pipefail
cd /opt/crm-backend
old_commit=$(git rev-parse HEAD)
backup_dir="/root/crm-pre-etapa2-$(date +%Y%m%d-%H%M%S)"
mkdir -m 700 "$backup_dir"
git diff > "$backup_dir/servidor.patch"
cp -a dist "$backup_dir/dist"
cp package-lock.json "$backup_dir/package-lock.json"
printf '%s\n' "$old_commit" > "$backup_dir/commit"
/usr/local/sbin/backup-crm.sh
latest_backup=$(find /root/backups-crm -maxdepth 1 -name 'crm-*.sql.gz' -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)
gzip -t "$latest_backup"
stat -c 'Backup BD: %n (%s bytes)' "$latest_backup"
printf '%s\n' "$latest_backup" > "$backup_dir/base-path"
git diff --exit-code -- . ':!package-lock.json'
git restore --source=HEAD -- package-lock.json
chown -R crmapp:crmapp /opt/crm-backend
sudo -u crmapp git pull --ff-only origin main
test "$(git rev-parse --short HEAD)" = '775abbd'
sudo -u crmapp npm install
sudo -u crmapp npx prisma migrate deploy
sudo -u crmapp npx prisma generate
sudo -u crmapp npm run build
test -s dist/main.js
systemctl restart crm_backend.service
for i in $(seq 1 20); do
  if curl --fail --silent http://127.0.0.1:3001/health > "$backup_dir/health.json"; then break; fi
  sleep 1
done
curl --fail --silent http://127.0.0.1:3001/health
test "$(curl --silent --output /dev/null --write-out '%{http_code}' --header 'Content-Type: application/json' --request POST http://127.0.0.1:3001/auth/login --data '{}')" = 400
test "$(curl --silent --output /dev/null --write-out '%{http_code}' http://127.0.0.1:3001/planilla-comisiones/periodos)" = 401
git rev-parse HEAD
stat -c 'Artefacto: %y %n' dist/main.js
systemctl show crm_backend.service -p ActiveState -p SubState -p ActiveEnterTimestamp -p NRestarts
printf 'DEPLOY OK; respaldo aplicación: %s\n' "$backup_dir"
