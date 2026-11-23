# 8. Verificación según el cambio

> Parte de la skill `crm-backend-arquitectura`: lee antes su [índice](../SKILL.md).

Para documentación, bastan las comprobaciones documentales indicadas en
CLAUDE. Lo siguiente corresponde a código/infraestructura, según el alcance;
no ejecutar integración destructiva para corregir prosa.

- `npm run build` (incluye `check:skills`) sin errores.
- `npm test -- --runInBand` en verde; los conteos cambian con el código.
- Si tocaste algo con lógica de negocio real (no solo observabilidad/infra):
  `npm run test:integracion:preparar && npm run test:integracion` contra
  Postgres real — necesita un Postgres en `:5433`. Si no hay uno a mano, se
  levanta uno descartable sin Docker ni systemd, como usuario normal (probado
  el 2026-08-27; antes esto decía "ver el historial de aquel chat", que es un
  puntero a nada):

  ```bash
  # Linux con PostgreSQL 16; en macOS sustituir por la carpeta de sus binarios.
  CRM_PG_BIN=/usr/lib/postgresql/16/bin
  CRM_PG_DIR=$(mktemp -d "${TMPDIR:-/tmp}/crm-postgres.XXXXXX")
  "$CRM_PG_BIN/initdb" -D "$CRM_PG_DIR/data" -U crm_app --auth=trust -E UTF8
  "$CRM_PG_BIN/pg_ctl" -D "$CRM_PG_DIR/data" -o "-p 5433 -h 127.0.0.1 -k $CRM_PG_DIR" -l "$CRM_PG_DIR/postgres.log" -w start
  npm run test:integracion:preparar && npm run test:integracion
  "$CRM_PG_BIN/pg_ctl" -D "$CRM_PG_DIR/data" -m fast -w stop
  # Borrar únicamente CRM_PG_DIR después de detener este servidor descartable.
  ```

  `--auth=trust` es aceptable porque escucha solo en loopback y muere con el
  directorio. Las suites usan `crm_app:crm_dev_local`; con trust la contraseña
  no se verifica. Comprobar primero que :5433 esté libre y no iniciar esta receta
  sobre un servidor preexistente. Las suites comparten crm_test y deben ir en serie. Vale la pena montarlo aunque sea para una
  sola prueba: sin base real, "compila" es todo lo que se puede afirmar.
- Si el cambio va a producción: seguir §4 completo, sin saltarse el backup ni
  la verificación posterior. "Compiló" no es "funciona" — este proyecto lo
  usan agentes reales sobre datos de pacientes reales, todos los días, sin red
  de staging debajo.
