# 4. Cómo desplegar

> Parte de la skill `crm-backend-arquitectura`: lee antes su [índice](../SKILL.md).

Sin entorno de staging (CLAUDE.md lo dice arriba de todo): esta secuencia es la
única red de seguridad. **No la acortes.**

```bash
# 1. En tu máquina: fetch primero (dos máquinas, puede haber commits ajenos)
git fetch origin && git log HEAD..origin/main --oneline   # vacío = OK

# 2. Commit + push a main (no hay ramas de feature en este repo; se trabaja
#    directo sobre main y se despliega seguido — normal para este proyecto)
git add -A && git commit -m "..." && git push origin main

# 3. En el servidor, SIEMPRE backup real antes de tocar nada:
export PGPASSWORD='...'   # ver §6 — NO está en este archivo
pg_dump -h localhost -p 5432 -U crm_app -d crm | gzip > /root/backup-crm-$(date +%Y%m%d-%H%M%S).sql.gz
# Verificar que el backup pesa algo de verdad (no un gzip vacío por un error de auth):
ls -la /root/backup-crm-*.sql.gz   # varios MB, no unos bytes

# 4. Deploy — encadenado con && A PROPÓSITO (ver la trampa de abajo)
cd /opt/crm-backend
chown -R crmapp:crmapp /opt/crm-backend && \
sudo -u crmapp git pull --ff-only origin main && \
sudo -u crmapp npm ci && \
sudo -u crmapp npx prisma migrate deploy && \
sudo -u crmapp npx prisma generate && \
sudo -u crmapp npm run build && \
systemctl restart crm_backend.service && \
echo "DEPLOY OK"

# 5. Verificar — no dar por hecho que "systemctl is-active" alcanza
journalctl -u crm_backend.service -n 30 --no-pager   # sin errores, "successfully started"
curl -s http://127.0.0.1:3001/health                  # 200, baseDatos: "ok"
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3001/auth/login -d '{}'
  # → 400: el ValidationPipe sigue vivo
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/planilla-comisiones/periodos
  # → 401: el guard sigue vivo
```

**Una migración que BORRA (columna, tabla) va en dos despliegues y se aplica
después del reinicio (expand/contract).** La secuencia de arriba migra antes de
compilar: correcto para lo que AÑADE, roto para lo que quita. Mientras compila el
nuevo —un par de minutos— sigue vivo el proceso anterior, y su cliente de Prisma
pide la columna en toda consulta sin `select` explícito: borrarla con él vivo hace
fallar esas consultas justo en ese rato. Por eso:

1. **Expand** (un despliegue normal): crear lo nuevo, copiar los datos y dejar
   de leer/escribir lo viejo. Lo viejo sigue en el schema, marcado como retirado.
2. **Contract** (otro despliegue, cuando el anterior ya está en marcha): quitar
   el campo del schema con su `DROP`, y desplegar **cambiando el orden**:
   `git pull` → `npm ci` → `prisma generate` → `npm run build` → `systemctl
   restart` → **y recién entonces** `prisma migrate deploy`. El proceso nuevo ya no
   conoce la columna, y una columna de más en la base no le molesta a Prisma.

Hecho así por primera vez el 2026-09-29 con `AccesoLineaWhatsapp.notificar` →
`SilencioLinea` (migraciones `20260929210000` y `20260929220000`).

**Desde el 2026-09-02 hay además un respaldo automático**, que NO reemplaza al
manual de arriba: el de antes del despliegue sigue siendo obligatorio, porque el
automático corre a las 03:15 y puede tener casi un día de antigüedad.

```
/usr/local/sbin/backup-crm.sh     # el script
/etc/cron.d/backup-crm            # 15 3 * * *  root
/root/backups-crm/                # destino, retiene 14 días
journalctl -t backup-crm          # así se ve si corrió y cuánto pesó
```

El script lee la credencial de `/opt/crm-backend/.env` en vez de duplicarla (si
la contraseña cambia ahí, sigue funcionando), y **aborta si el dump pesa menos de
1 MB**, renombrándolo a `.SOSPECHOSO`. Solo borra archivos con su propio prefijo
`crm-*`, así que nunca toca los respaldos manuales `backup-crm-*` previos al
despliegue. Existía un hueco real: antes de esto el respaldo más reciente era del
29 de agosto, cuatro días viejo, sobre datos de pacientes reales y sin staging.

**Desde el 2026-10-26 hay respaldo externo** en Google Cloud Storage, para el
caso que los locales no cubren: perder el VPS entero. Versión en el repo:
`scripts/respaldo-externo/` (script, servicio y temporizador; copiarlos al
servidor si cambian).

```
/usr/local/sbin/respaldo-externo.sh        # el script
respaldo-externo.timer                     # 04:30 hora del VPS, tras los locales de 03:15
journalctl -u respaldo-externo             # «OK en N s: …» o «FALLO: …»
/var/lib/respaldo-externo/ultimo-ok        # fecha UTC del último respaldo completo
/etc/respaldos-externos/                   # clave pública age, llave de la cuenta, rclone.conf
gs://crm-clinica-montalvo-respaldos        # proyecto crm-clinica-montalvo, us-east1
```

| Prefijo | Qué | Vida (ciclo del bucket) |
| --- | --- | --- |
| `crm/diario/` | `crm-*.dump.age` (pg_dump -Fc) y `config-*.tar.age` (.env, /etc/montalvo-resultados, unidades, Apache) | 35 días |
| `resultados/diario/` | `resultados-*.dump.age` | 35 días |
| `*/mensual/` | el primer volcado de cada mes | Archive a los 30 días, se borra a los 400 |
| `resultados/archivos/` | PDF y adjuntos, ya cifrados por la app (MNTV1/2); incremental | Coldline a 90 días, Archive al año |
| `r2/` | copia de R2 cifrada con rclone crypt (nombres incluidos); incremental | Coldline a 90 días, Archive al año |

Decisiones:

- **Cifrado con la clave PÚBLICA de `age`.** El servidor cifra pero no puede
  descifrar: la clave privada y las contraseñas de `r2cifrado` las guarda el
  dueño fuera del VPS (gestor de contraseñas). Sin ellas los respaldos no sirven;
  sin la `STORAGE_ENCRYPTION_KEY` que va en `config-*`, tampoco los PDF.
- **La cuenta `respaldos-vps` solo crea y lee** (`objectCreator` + `objectViewer`
  en el bucket) y el bucket tiene **retención de 30 días**: ni el VPS ni el dueño
  pueden borrar o sobrescribir un respaldo antes. Por eso las copias usan
  `--ignore-existing` y nombres con sello de tiempo. La papelera retiene 7 días más.
- Cada volcado se comprueba con `pg_restore --list` y un mínimo de tamaño antes
  de cifrarse; al final `rclone check` confirma que no falta ningún archivo.
- Alerta de presupuesto de $5/mes en Cloud Storage (sin contar créditos).
  El proyecto es el mismo de Vertex: si la cuenta de prueba de Google vence sin
  pasar a pago, se detienen el bucket Y la IA.

Restaurar (desde una máquina con la clave privada, `age` y `rclone`):

```bash
gcloud storage cp gs://crm-clinica-montalvo-respaldos/crm/diario/crm-<sello>.dump.age .
age -d -i clave-privada-age.txt crm-<sello>.dump.age > crm.dump
pg_restore --list crm.dump            # índice; restaurar con pg_restore -d <base> sobre una base vacía
# R2: un remote crypt con las dos contraseñas sobre gcs:crm-clinica-montalvo-respaldos/r2
```

Probado el 2026-10-26: los dos volcados se descifraron y `pg_restore` los leyó
(67 y 10 tablas con datos), la configuración trae 30 entradas, y seis archivos al
azar de R2 y Resultados restaurados resultaron idénticos al original.

**Por qué el backup se verifica y no se asume**: la primera vez que desplegué
así, `pg_dump -U postgres crm` sin la contraseña correcta falló en silencio
(`2>/dev/null` se come el error) y el gzip resultante tenía **20 bytes** — un
backup vacío que parecía exitoso. `ls -la` del archivo y confirmar que pesa MB,
no bytes, es lo único que lo hubiera atrapado antes de necesitarlo. Esa cicatriz
es justo la que el chequeo del script automatiza.

**Por qué va el `chown -R` antes de todo** (2026-08-26): varios archivos de
`/opt/crm-backend` habían quedado con dueño `root` en vez de `crmapp` —
`dist/`, `package-lock.json`, `tsconfig.json`, `CLAUDE.md`— de alguna vez que
algo se corrió como root sin bajar de privilegios. Consecuencia: `sudo -u
crmapp npm install` muere con `EACCES ... package-lock.json` y `npm run build`
no puede escribir en `dist/`. El `chown` deja el directorio consistente antes
de empezar y cuesta nada.

**Por qué el `&&` no es cosmético — la trampa que de verdad mordió ese día.**
Los siete comandos se pegaron en la terminal como líneas sueltas. `npm install`
falló por el `EACCES` de arriba... y bash ejecutó igual las cuatro líneas
siguientes, incluido `systemctl restart`. Resultado: el servicio se reinició
**con el binario viejo**, `git log` decía el commit nuevo, `systemctl is-active`
decía `active`, el `/health` respondía 200 y los curl de 400/401 pasaban. Todo
verde, nada desplegado. Encadenar con `&&` y cerrar con `echo "DEPLOY OK"` hace
que un fallo intermedio corte la cadena y se note.

**Dos cosas que rompen el `git pull` y el `npm install`, y cómo se ven**
(2026-08-29, el despliegue que trajo `pdfkit`):

1. **El lockfile del servidor se ensucia solo.** `npm install` le añade el
   bloque `engines` a `package-lock.json`, y el siguiente `git pull --ff-only`
   aborta con *"Your local changes would be overwritten by merge"*. Es ruido de
   npm en aquel incidente. Hoy usar `npm ci` para no reescribir el lockfile;
   si Git muestra cambios, revisar y conservar cualquier cambio intencional
   antes del pull. No descartar automáticamente el lockfile.

2. **`crmapp` no tenía `/home/crmapp`**, aunque su entrada de `passwd` lo
   declara. Ningún despliegue lo notó durante meses porque npm solo escribe su
   caché cuando hay algo que DESCARGAR: mientras no entró una dependencia nueva,
   `npm install` no tocaba `~/.npm`. El día que llegó `pdfkit` falló con
   `EACCES: permission denied, mkdir '/home/crmapp'`. Arreglado creando el
   directorio (`mkdir -p /home/crmapp && chown crmapp:crmapp`).

**Y lo que de verdad duele: un `npm install` que muere a mitad deja
`node_modules` corrupto.** Los avisos `npm warn cleanup ENOTEMPTY` no son
cosméticos — quedan paquetes a medio borrar. El siguiente arranque muere con
`Cannot find module '.../object-is/index.js'`, y como la unidad tiene
`Restart=always`, **`systemctl is-active` sigue diciendo `active` mientras el
proceso entra en bucle de caída**. El servicio estuvo abajo ~4 minutos con todos
los indicadores en verde salvo el `curl`.

La reparación es reinstalar limpio, no reintentar encima:

```bash
rm -rf node_modules && chown -R crmapp:crmapp /opt/crm-backend && sudo -u crmapp npm ci && sudo -u crmapp npx prisma generate && sudo -u crmapp npm run build && systemctl restart crm_backend.service
```

**Corolario para la verificación**: `is-active` + `/health` + 400/401 **no
prueban que el deploy ocurrió** — prueban que el proceso está sano, sea cual
sea el código que corre. Lo que sí lo prueba son estas dos líneas:

```bash
date -r /opt/crm-backend/dist/main.js                      # ¿se recompiló recién?
systemctl show crm_backend.service -p ActiveEnterTimestamp # ¿arrancó después?
curl -s http://127.0.0.1:3001/health                       # ¿RESPONDE, no "está active"?
```

Ese `curl` es el único que distingue "arriba" de "reiniciándose en bucle": con
`Restart=always`, un proceso que muere al arrancar se ve `active` para siempre.

Si el binario compilado del servidor es más viejo que el `git pull`, no se
desplegó nada por más que el commit sea el correcto y el servicio esté arriba.
(Ese artefacto vive solo en `/opt/crm-backend` y está gitignorado — no lo cites
como ruta del repo o `check:skills` lo marca, con razón, como inexistente.)

Si `schema.prisma` cambió: la migración se genera con `--create-only`, se revisa
el SQL a mano (hay datos reales), y recién ahí se aplica. Ver `crm-backend-module`
para el patrón completo de migraciones y el caso de drift.

### Prisma 7 (desde 2026-09-05): cuatro cosas que rompen el despliegue en verde

La migración de Prisma 5 a 7 dejó cuatro trampas que **compilan, pasan las 709
pruebas y aun así tumban el servicio**. Se documentan acá y no en
`crm-backend-module` porque las cuatro son del despliegue, no del código.

1. **El binario compilado puede mudarse solo.** `prisma.config.ts` vive en la RAÍZ del
   repo, y al aparecer, tsc dedujo `rootDir: "."`: la salida pasó de
   **dist/main.js** a **dist/src/main.js**. La unidad de systemd arranca la
   primera, así que el
   build habría quedado en verde y el servicio en bucle de caída — que con
   `Restart=always` se ve `active` para siempre. Ya está fijado
   (`"rootDir": "./src"` + `prisma.config.ts` excluido del build), pero si
   alguien añade otro archivo TypeScript en la raíz, **verificá que el
   **dist/main.js** del servidor siga existiendo** antes de reiniciar.

2. **`prisma generate` corre en cada `npm install`** (hook `postinstall`), y con
   el helper `env()` de `prisma/config` fallaba sin `DATABASE_URL` aunque
   generate no toque la base. Eso rompía la cadena en su PRIMER paso. Resuelto
   usando `process.env` en `prisma.config.ts`; si vuelve a aparecer un
   `env(...)` ahí, vuelve el fallo.

3. **El cliente generado no está en git** (`/src/generated/`), así que sin
   `prisma generate` no hay build. La cadena de arriba ya lo corre, y ahora
   además el `postinstall`.

4. **`node_modules/.prisma/` puede quedar con el motor Rust viejo.** npm no
   limpia ese directorio: tras actualizar quedó un `libquery_engine` de 17 MB
   del v5 que ya nadie carga. Es inofensivo pero engaña al inspeccionar; si
   querés confirmar que el cliente es de verdad *Rust-free*, borralo y volvé a
   correr las pruebas (probado: siguen en verde).

**Qué gana el servidor con esto:** el cliente ya no carga un binario Rust de
**17,2 MB** en el proceso — decisivo en la máquina de 1,7 GB donde se hizo
esta migración, y todavía memoria que no se le quita al vecino (§2). El pool de conexiones dejó de ser el `núcleos × 2 + 1` = **3** que
decidía el motor y ahora es un `pg.Pool` de **10**, dimensionado a mano contra
el `max_connections = 100` real del servidor: se acabó que el barrido de
recordatorios compitiera con las peticiones de las agentes por tres conexiones.

**Lo que NO gana:** velocidad que se note al navegar. Prisma 7 es ~3x más rápido
devolviendo miles de filas, pero acá la consulta son 6-27 ms de un viaje de
~190 ms (§7 y `crm-rendimiento` del frontend). Donde sí se nota es en la
planilla de comisiones y los exports, que sí mueven miles de filas.
