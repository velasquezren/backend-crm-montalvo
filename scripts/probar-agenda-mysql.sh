#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# MySQL descartable: docker por defecto; sin docker, un MySQL 8.0.44 descomprimido
# (tarball oficial, sin instalar nada) con AGENDA_MYSQL_BASEDIR=<carpeta con bin/mysqld>.
# Puerto y nombre propios: falla si 3307 está ocupado, sin tocarlo. Nunca volúmenes reales.
AGENDA_TEST_DIR=$(mktemp -d /tmp/montalvo-agenda-test.XXXXXX)

if [ -n "${AGENDA_MYSQL_BASEDIR:-}" ]; then
  B="$AGENDA_MYSQL_BASEDIR/bin"
  "$B/mysqld" --version | grep -q ' 8\.0\.44 ' || { echo "Se espera MySQL 8.0.44 (el del VPS)"; exit 1; }
  cleanup() {
    "$B/mysqladmin" -uroot -h127.0.0.1 -P3307 shutdown >/dev/null 2>&1 || true
    [ -n "${PID_MYSQL:-}" ] && wait "$PID_MYSQL" 2>/dev/null || true
    rm -rf "$AGENDA_TEST_DIR"
  }
  trap cleanup EXIT
  "$B/mysqld" --no-defaults --initialize-insecure --basedir="$AGENDA_MYSQL_BASEDIR" --datadir="$AGENDA_TEST_DIR/datos" >/dev/null 2>&1
  "$B/mysqld" --no-defaults --basedir="$AGENDA_MYSQL_BASEDIR" --datadir="$AGENDA_TEST_DIR/datos" \
    --bind-address=127.0.0.1 --port=3307 --socket="$AGENDA_TEST_DIR/mysql.sock" --mysqlx=OFF \
    --default-time-zone=-04:00 --log-error="$AGENDA_TEST_DIR/error.log" &
  PID_MYSQL=$!
  for i in {1..60}; do
    if "$B/mysqladmin" -uroot -h127.0.0.1 -P3307 ping --silent >/dev/null 2>&1; then break; fi
    sleep 1
  done
  "$B/mysql" -uroot -h127.0.0.1 -P3307 < test/agenda/legado-sintetico.sql
  cp "$AGENDA_TEST_DIR/datos/ca.pem" "$AGENDA_TEST_DIR/ca.pem"
else
  AGENDA_TEST_CONTAINER="montalvo-agenda-test-$$"
  cleanup() { docker rm -f "$AGENDA_TEST_CONTAINER" >/dev/null 2>&1 || true; rm -rf "$AGENDA_TEST_DIR"; }
  trap cleanup EXIT
  # Imagen fijada: mismo MySQL 8.0.44 que el VPS.
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
fi

AGENDA_MYSQL_TEST=on AGENDA_MYSQL_TEST_CA="$AGENDA_TEST_DIR/ca.pem" \
  npx jest --runInBand --testPathIgnorePatterns '/node_modules/' --testPathPattern 'agenda.mysql.integracion.spec.ts$'
