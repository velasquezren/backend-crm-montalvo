#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Puerto y nombre propios. docker falla si 3307 está ocupado, sin tocarlo.
AGENDA_TEST_CONTAINER="montalvo-agenda-test-$$"
AGENDA_TEST_DIR=$(mktemp -d /tmp/montalvo-agenda-test.XXXXXX)
cleanup() { docker rm -f "$AGENDA_TEST_CONTAINER" >/dev/null 2>&1 || true; rm -rf "$AGENDA_TEST_DIR"; }
trap cleanup EXIT
# Imagen fijada: mismo MySQL 8.0.44 que el VPS; nunca usar volúmenes reales.
docker run -d --name "$AGENDA_TEST_CONTAINER" -p 127.0.0.1:3307:3306 \
  -e MYSQL_ALLOW_EMPTY_PASSWORD=yes -e MYSQL_ROOT_HOST=% \
  mysql:8.0.44@sha256:9c3380eac945af0736031b200027f581925927c81e010056214a4bd6b6693714 \
  --default-time-zone=-04:00 >/dev/null
for i in {1..60}; do
  if docker exec "$AGENDA_TEST_CONTAINER" mysqladmin ping -h127.0.0.1 --silent >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec -i "$AGENDA_TEST_CONTAINER" mysql -uroot < test/agenda/legado-sintetico.sql
docker cp "$AGENDA_TEST_CONTAINER:/var/lib/mysql/ca.pem" "$AGENDA_TEST_DIR/ca.pem" >/dev/null
AGENDA_MYSQL_TEST=on AGENDA_MYSQL_TEST_CA="$AGENDA_TEST_DIR/ca.pem" \
  npx jest --runInBand --testPathIgnorePatterns '/node_modules/' --testPathPattern 'agenda.mysql.integracion.spec.ts$'
