---
name: crm-backend-arquitectura
description: Mapa completo del backend — infraestructura real de producción (VPS compartido, systemd, Apache/httpd, Postgres), cómo desplegar paso a paso, la escala real de datos, qué decisiones de arquitectura ya están tomadas y por qué, y dónde mirar para rendimiento/escalabilidad. Úsalo para cualquier tarea que no sea "tocar un endpoint" — desplegar, diagnosticar lentitud o un incidente, decidir si algo escala, entender por qué el servidor está configurado así, u orientarte la primera vez que trabajas en este repo. Para el patrón de código de un módulo (paginación, roles, DTOs, webhooks) usa `crm-backend-module`; este skill es el contexto de alrededor.
---

# Mapa del backend — CRM Clínica Montalvo

Esto es lo que un agente nuevo (o vos mañana, sin memoria de hoy) necesita para no
perderse: dónde vive cada cosa, en qué máquina real corre, cuánta gente y cuántos
datos hay de verdad, qué ya está resuelto, y dónde mirar si hay que hacerlo más
rápido o más grande. Todo lo que sigue lo verifiqué contra el servidor real:
primero el 2026-08-21, y revisado de punta a punta el **2026-09-02**, día en que
además se cambiaron varias cosas de la máquina (§9). No es una descripción de
memoria — donde algo pueda haber cambiado, lo digo.

**Este skill NO repite `crm-backend-module`** (paginación, roles, DTOs, webhooks,
concurrencia). Léelos como un par: ese es el "cómo escribo código en un módulo",
este es "dónde vive el sistema y qué tan grande es de verdad".

## 1. El sistema, en una pantalla

```
Angular 21 (PWA)  ──HTTPS──▶  Apache/httpd (crm.107.172.193.34.nip.io)
en Vercel                      TLS Let's Encrypt, HTTP/2 al navegador
                                │
                                ├─ proxy HTTP/1.1 ──▶ NestJS (127.0.0.1:3001)
                                └─ proxy WS (socket.io) ──▶ mismo puerto
                                                              │
                                                        Postgres 16
                                                    (localhost:5432, solo esta app)
```

- **Backend** (este repo): NestJS 10 + Prisma 5 + PostgreSQL, TypeScript estricto.
- **Frontend**: Angular 21, PWA, en el repo hermano `frontend-crm-montalvo/`,
  desplegado en **Vercel** — no vive en el mismo servidor que el backend.
- El backend NO sirve HTML ni assets: es una API REST + un gateway WebSocket.
- `CRM_MANIFESTO.md` (en el repo del frontend) es la referencia de arquitectura
  que gobierna los dos repos; los skills de acá la citan.

## 2. La máquina real — esto es lo que más se pierde

El servidor **NO es dedicado a este CRM**. Es un VPS AlmaLinux compartido con
otros dos proyectos del mismo dueño:

```
$ nproc && free -h
1                                    ← UN solo núcleo de CPU
              total   used   free
Mem:          1.7Gi   671Mi  594Mi   ← 1.7 GB de RAM, TOTAL de la máquina

$ systemctl list-units --type=service --state=running
crm_backend.service            ← este backend
dulce_espera_backend.service   ← FastAPI, otro proyecto
mysqld.service                 ← MySQL 8, lo usa el otro proyecto
postgresql.service             ← Postgres, SOLO lo usa este CRM
httpd.service                  ← Apache (RHEL usa "httpd", no "apache2")
fail2ban.service               ← desde el 2026-09-02, ver §6
webmin.service, vsftpd.service ← panel y FTP del dueño, ajenos al CRM

# agenda-api.service (FastAPI, un tercer proyecto) quedó DETENIDO y deshabilitado
# el 2026-09-02, por decisión del dueño. No se borró nada: sus archivos
# (/opt/agenda_api, 75 MB) y su base MySQL `agenda` (6 tablas, 16 filas) siguen
# ahí. Se revierte con:  systemctl enable --now agenda-api
```

**Por qué importa**: un solo núcleo significa que cualquier trabajo síncrono
pesado en el event loop de Node (parsear un Excel grande con `exceljs`, un hash
de bcrypt, un `JSON.stringify` de una respuesta enorme) bloquea a **todos** los
usuarios conectados en simultáneo, no compite por CPU con otro proceso — la
compite con las otras peticiones de este mismo backend. 1.7 GB de RAM total,
repartidos entre systemd, MySQL, Postgres, httpd y tres backends, es la razón
de fondo de varias decisiones que ya están tomadas (ver §5).

`crm_backend.service` (`systemctl cat crm_backend.service` en el servidor):

```ini
[Service]
Type=simple
User=crmapp
Group=crmapp
WorkingDirectory=/opt/crm-backend
EnvironmentFile=/opt/crm-backend/.env
ExecStart=/usr/bin/node dist/main.js
Restart=always
RestartSec=5

# Endurecimiento
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/crm-backend

# Límite de memoria: el VPS tiene 1.7G y comparte con MySQL/Apache/FastAPI
MemoryMax=400M
```

**`MemoryMax=400M` es un techo real, no decorativo**: si el proceso Node lo supera,
systemd lo mata (y `Restart=always` lo revive, pero eso es una caída, no una
degradación). Cualquier cambio que cargue más en memoria de golpe (un `findMany`
sin `take`, un array grande armado antes de responder) tiene mucho menos margen
acá que en un servidor típico de 4-8 GB. Es la misma razón de fondo detrás de
"todo listado se pagina" y de que la caché (`common/cache/cache-memoria.ts`) tenga
tope de entradas — no es solo estilo, es que el proceso no puede crecer libre.

Node y npm en el servidor: `v22.23.1` / `10.9.8` — coincide con lo que pide
`package.json` (`engines.node >= 22`).

### El reverse proxy (Apache/httpd)

`/etc/httpd/conf.d/crm_backend-le-ssl.conf` en el servidor (resumido):

```apache
<VirtualHost *:443>
    ServerName crm.107.172.193.34.nip.io
    Protocols h2 http/1.1              # HTTP/2 solo navegador↔Apache
    ProxyPreserveHost On

    # Upgrade a WebSocket para el inbox de Conversaciones (socket.io)
    RewriteCond %{HTTP:Upgrade} =websocket [NC]
    RewriteRule ^/socket.io/(.*) ws://127.0.0.1:3001/socket.io/$1 [P,L]
    ProxyPass /socket.io/ http://127.0.0.1:3001/socket.io/
    ProxyPassReverse /socket.io/ http://127.0.0.1:3001/socket.io/

    ProxyPass / http://127.0.0.1:3001/
    ProxyPassReverse / http://127.0.0.1:3001/

    SSLCertificateFile /etc/letsencrypt/live/crm.107.172.193.34.nip.io/fullchain.pem
</VirtualHost>
```

- El dominio es un **`nip.io`** (DNS wildcard que resuelve al propio IP): no hay
  un dominio propio comprado para el backend. El frontend sí puede tener el suyo
  en Vercel — son cosas independientes.
- `main.ts` confía en el proxy solo si es loopback (`app.set('trust proxy', 'loopback')`):
  así `req.ip` toma la IP real del `X-Forwarded-For` que agrega Apache, y el
  rate-limit por IP funciona de verdad. Ver `crm-backend-module` para el porqué.

### Postgres

Solo esta app lo usa (MySQL es de los otros proyectos). `max_connections = 100`
a nivel servidor; Prisma se conecta con `connection_limit=10&pool_timeout=10` en
`DATABASE_URL`.

**Ese 10 era 25 hasta el 2026-09-02**, y bajarlo fue una de las optimizaciones de
ese día. Prisma mantiene el pool abierto aunque nadie lo use: había **25 conexiones
ociosas permanentes** —la más vieja llevaba 6 horas sin una sola query— que
costaban **69 MB de memoria privada**, medidos con `smaps_rollup`, sobre los
1.7 GB que tiene la máquina entera. Para un backend que sirve ~1.580 peticiones
por semana (§7), 10 sigue siendo holgado: la recomendación de Prisma para un solo
núcleo es `núcleos * 2 + 1`, o sea 3. Tras el cambio `pg_stat_activity` pasó de
25 conexiones a 1.

## 3. Escala real de datos (medida en producción, no estimada)

Remedido el **2026-09-02** (`pg_stat_user_tables`); entre paréntesis, lo que
había el 2026-08-26, para que se vea la pendiente y no solo la foto:

```
Lead            15.665  (15.620)
Cliente         15.652  (15.608)   33 MB — 21 MB tabla + 11 MB índices
Mensaje          2.564   (2.186)
VentaImportada   2.368   (1.287)   ← +84 % en una semana
AuditLog           583     (473)
Conversacion       370     (325)
Venta                6       (3)
```

**La que crece rápido ahora es otra**: hasta el 2026-08-26 eran las dos del
inbox (`Mensaje` y `Conversacion`, que motivaron el arreglo de `LIMITE_INBOX`
en §7). En la semana siguiente el inbox se calmó (+17 % y +14 %) y el salto se
lo llevó **`VentaImportada`, que casi se duplicó: 1.287 → 2.368 (+84 %)**.

Eso importa porque `VentaImportada` es justo la tabla que alimentan y leen el
parseo y la exportación de Excel con `exceljs` — el trabajo síncrono que bloquea
el único núcleo (§7). Todavía no duele, pero es el número a mirar la próxima vez
que alguien reporte que la planilla "se cuelga", y ya no vale el "hoy con 1.287
filas probablemente no se nota" que dice más abajo esta misma sección.

Las dos tablas grandes siguen planas: `Cliente` y `Lead` sumaron ~45 filas cada
una en esos siete días (+0,3 %). Las grandes no crecen; las chicas sí.

`TipoCambioDiario` (módulo `tipo-cambio`, agregado después de esta medición)
no está en la tabla: es un valor por día, así que su techo natural es ~365
filas/año aunque nunca se pierda una sincronización — no hace falta remedirlo
para saber que no es un problema de escala.

Base completa: **60 MB**. Esto importa para calibrar cualquier conversación sobre
"performance": **no es un problema de volumen de datos** — 60 MB entra entero en
RAM varias veces. El cuello de botella de este sistema es la máquina de un solo
núcleo y 1.7 GB compartidos (§2), no el tamaño de las tablas. Optimizar asumiendo
un problema de "big data" que no existe sería resolver lo que no duele.

`Venta` pasó de 0 (2026-08-21) a 3 (2026-08-26) a 6 (2026-09-02): se usa, pero
a cuentagotas. Sigue en pie la lectura de que el flujo real de ventas vive
todavía en `VentaImportada` (el Excel de comisiones) y que el módulo `Ventas` es
nuevo o está en migración. No es código muerto — confirmar con quien conoce el
negocio antes de tocarlo.

## 4. Cómo desplegar

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
sudo -u crmapp npm install && \
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
   npm, no contenido: `sudo -u crmapp git checkout -- package-lock.json` antes
   del pull y listo.

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
rm -rf node_modules && chown -R crmapp:crmapp /opt/crm-backend && sudo -u crmapp npm install && sudo -u crmapp npx prisma generate && sudo -u crmapp npm run build && systemctl restart crm_backend.service
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

## 5. Decisiones de arquitectura ya tomadas — no las reabras sin el porqué

Cada una de estas resuelve algo específico del contexto de §2 (una sola CPU,
1.7 GB compartidos, sin staging) o de la escala real de §3. Si una te parece
"de más", probablemente estás a punto de reintroducir el problema que resolvió.

- **`common/auth/roles.ts`** — única fuente de la jerarquía de roles
  (`AGENTE` < `ADMIN` < `SUPER_ADMIN`). `RolesGuard` y el escopado por agente
  leen de acá; nunca se compara `usuario.rol === 'ADMIN'` a mano. Detalle
  completo en `crm-backend-module`.
- **`common/cache/cache-memoria.ts`** — una sola implementación de caché
  in-process, con TTL y tope de entradas. Vive en el proceso porque hay UNA
  instancia (§2); si esto escala a varias instancias, es el único lugar donde
  cambiar a Redis. No es prematuro tenerlo centralizado: había tres `Map`
  distintos con `expiresAt` a mano y uno nunca limpiaba — así se llegó a una
  fuga de memoria real en KPIs.
- **`common/guards/meta-signature.guard.ts`** — la firma HMAC de Meta se
  verifica en un solo lugar compartido por todos los webhooks (WhatsApp, Lead
  Ads), no reimplementada por cada uno. `check:skills` obliga a que todo
  `@Post()` bajo `webhooks/` lo use.
- **`common/audit/audit.service.ts`** — auditoría centralizada para mutaciones
  críticas (ventas, comisiones, reasignación de clientes). Nunca tumba la
  operación de negocio (va en try/catch).
- **Observabilidad** (agregada 2026-08-20): `common/logging/request-id.middleware.ts`
  asigna un id por petición (`X-Request-Id`); `common/logging/logging.interceptor.ts`
  registra una línea por petición exitosa; `common/filters/all-exceptions.filter.ts`
  es la red de seguridad para lo que no es un `HttpException` — no cambia la
  forma de los errores existentes, solo suma `requestId`. `common/health/health.controller.ts`
  expone `GET /health` con chequeo real de base (`SELECT 1`).
- **Split de mensajería de WhatsApp** (2026-08-20): `conversaciones.service.ts`
  llegó a 1025 líneas mezclando CRUD/lectura del inbox, mensajería saliente del
  agente e ingesta del webhook entrante. `modules/conversaciones/ingesta-whatsapp.service.ts`
  se llevó solo la ingesta (`procesarEntrante`, get-or-create de conversación,
  acuse fuera de horario) — único llamador: el controller del webhook. Mismo
  comportamiento, mismas queries, verificado con la suite de integración contra
  Postgres real antes de tocar producción.
- **WebSocket para "algo cambió", REST para los datos** — el gateway nunca
  manda el dato en el payload del socket, solo avisa; evita que el escopado por
  rol tenga que reimplementarse en el canal de WebSocket.
- **Sin repository pattern, sin DDD/hexagonal, sin microservicios** — decisión
  activa, no descuido. A esta escala (§3) y con un solo proceso (§2), Prisma
  Client ya hace de repository; una capa extra de indirección no compra nada y si
  agrega la superficie que hay que mantener. Si el día de mañana el volumen o el
  equipo crecen 10x, ahí sí vale reabrir esta conversación — hoy no.
- **TypeScript en `strict` completo, sin `declaration`** (`23f8acd`, 2026-08-20)
  — antes eran tres banderas sueltas de la familia `strict`; con `strict`
  entero, `useUnknownInCatchVariables` volvió regla de compilador lo que hasta
  entonces era solo convención escrita (`catch (e: unknown)`, nunca `any`).
  Sacar `declaration` —nadie importa este backend como librería, y generaba
  113 `.d.ts` de más— bajó el build de 3,0 a 2,7s y el `dist/` de 2,1 a 1,5 MB
  (mediana de 3 builds limpios, medido en el commit). 10% menos en la máquina
  de un solo core que también corre el build (§2).
- **Cachear sin medir salió caro, y se revirtió** (`695d9d0`/`c9d2b72`,
  2026-08-19, revertidos en `69f80bc`, 2026-08-20) — caché en memoria para
  `dashboard`/`demografia`/`historialPaciente`/`perfilMedico` de `servicios`.
  Medido después: 1-3 ms de ahorro sobre un round-trip de ~190 ms (1,5%), y
  ninguna de las cuatro se invalidaba al reimportar la planilla o corregir una
  clasificación — de paso anulaba la invalidación del interceptor de caché del
  frontend, que sí funciona. Costo real, ganancia casi nula. Confirma la regla
  que el frontend ya fuerza con `check:skills` (`crm-rendimiento`: "un cambio
  de `perf` sin medición antes/después no se commitea") — **acá todavía es
  solo disciplina, no hay validador que la revise.** Antes de cachear algo en
  `servicios` o en cualquier módulo cuyos datos se reescriben al importar, mide
  el ahorro real y confirma cómo se invalida antes de usar el prefijo `perf`.

## 6. Credenciales y acceso — deliberadamente NO están en este archivo

Este archivo vive en el repo (`.claude/skills/`) y probablemente termina en
GitHub. Nunca pongas acá contraseñas, tokens o claves reales — quedan en el
historial de git para siempre, aunque se borren después.

Lo que sí conviene dejar anotado (sin el secreto):

- **Acceso al servidor**: hay **llave SSH para `root`** y funciona sin
  contraseña — verificado el 2026-08-26 con `ssh -o BatchMode=yes root@…`,
  que desactiva por completo el prompt de contraseña y aun así conecta. (Este
  archivo afirmaba lo contrario —"hoy es contraseña de root, no una llave"—
  hasta esa fecha.) **`crmapp` NO tiene llave**: `ssh crmapp@…` responde
  `Permission denied (publickey)`, así que todo despliegue entra como `root` y
  baja de privilegios con `sudo -u crmapp` comando a comando.

  **El ataque, medido de verdad** (2026-09-02): `/var/log/secure` tenía
  **2.206.756 intentos de contraseña fallidos desde 10.818 IPs distintas** y
  pesaba **971 MB acumulados en menos de una semana** — un ritmo sostenido de
  ~4,3 intentos por segundo. En una máquina de un solo núcleo compartida por
  varias aplicaciones, eso es CPU y disco robados todo el día. (La cifra de
  82.723 que traía antes este archivo salía del banner del login, que solo
  cuenta desde el último acceso exitoso: subestimaba el problema en 25x.)

  **Estado actual** (`sshd -T` + `fail2ban-client`, 2026-09-02):

  ```
  permitrootlogin yes
  passwordauthentication yes    ← sigue abierto, ver abajo
  pubkeyauthentication yes
  fail2ban: ACTIVO desde el 2026-09-02, jail sshd
  ```

  `fail2ban` (EPEL, ya estaba habilitado como repo) se instaló y configuró en
  `/etc/fail2ban/jail.local`: banea 1 hora tras 6 fallos en 10 minutos, con
  `ignoreip` para las IPs desde las que históricamente entró el dueño. Baneó a
  su primer atacante a los 8 segundos de arrancar. Efecto medido: el log pasó
  de ~1,6 MB cada 20 minutos a **16 KB en 20 minutos**, unas 100 veces menos.

  **Lo que sigue abierto**: `passwordauthentication yes`. Apagarlo es seguro y
  está verificado —no es una suposición—: las dos máquinas del dueño entran
  **por llave**, no por contraseña. El histórico de `/var/log/secure` lo
  confirma (`181.114.107.115` → 2.409 autenticaciones por llave pública;
  `190.186.23.243` → 20), y hay dos llaves distintas en
  `/root/.ssh/authorized_keys`, una RSA y una ED25519, una por máquina. El
  cambio quedó redactado pero **sin aplicar**, a la espera del dueño:

  ```
  # /etc/ssh/sshd_config.d/00-endurecimiento.conf   (00- para que gane por orden
  # alfabético sobre 01-permitrootlogin.conf y 50-redhat.conf, ya que sshd toma
  # el PRIMER valor que encuentra)
  PasswordAuthentication no
  PermitRootLogin prohibit-password
  KbdInteractiveAuthentication no
  ```

  Aplicarlo así, encadenado, para que no recargue si la sintaxis está mal:
  `sshd -t && systemctl reload sshd`. Con `fail2ban` puesto ya no es urgente,
  pero cierra la puerta del todo.
- **Credenciales de la base** (`crm_app` / password real): están en
  `/opt/crm-backend/.env` en el servidor, y en `.env` local (gitignorado, no
  confundir con `.env.example` que sí está en git y no lleva secretos).
- **`WHATSAPP_TOKEN` / `META_APP_SECRET` / `VAPID_*`**: mismo criterio, viven
  solo en `.env`. `.env.example` documenta cuáles son obligatorias y por qué
  (ver los comentarios ahí — `check:skills` obliga a que `META_APP_SECRET` esté
  documentada si hay webhooks).
- El repositorio de GitHub (`velasquezren/backend-crm-montalvo`) es accesible
  sin credenciales desde el servidor (`git pull` funciona sin llave ni token
  configurado para `crmapp`) — confirmar que esto es intencional; si el repo es
  público, el código (no los secretos, que están en `.env` gitignorado) es
  visible para cualquiera.

## 7. Dónde mirar para rendimiento y escalabilidad

Lo que sigue es honesto sobre lo que **no** verifiqué a fondo — son pistas
concretas basadas en lo que sí encontré hoy, no un análisis de performance real
con profiling. Antes de optimizar cualquiera de estos, medí primero (ver el
cierre de esta sección).

- **El event loop es de un solo hilo en una sola CPU (§2)**. Buscar en el
  código el trabajo síncrono pesado: `excel-parser.ts` y `exportacion-comisiones.service.ts`
  (parseo/generación de Excel con `exceljs`), `bcryptjs` en el login. Si las
  planillas de comisiones crecen mucho, ese parseo bloquea a todo el mundo
  mientras corre — candidato a mover a un `worker_thread` o a una cola si se
  vuelve perceptible. Hoy con 1.287 filas en `VentaImportada` probablemente no
  se nota; no asumas que seguirá sin notarse.
- **55 índices ya existen en `schema.prisma`**, incluyendo GIN trigram para
  búsqueda difusa en `Cliente` y `VentaImportada` — no es un punto de partida
  típico, ya está bastante trabajado. **Ya verificado cuáles se usan de verdad**
  (2026-08-26, `pg_stat_user_indexes`; `stats_reset` es `NULL`, o sea que los
  contadores cubren toda la vida de la base, no una ventana corta):

  ```
  Cliente_nombre_idx      1264 kB   0 scans
  Cliente_email_idx        440 kB   0 scans
  Cliente_saldoTotal_idx   384 kB   0 scans
  Lead_agenteId_idx        224 kB   0 scans
  ```

  Son ~2,3 MB que solo pagan costo de escritura. `Cliente_nombre_idx` es el caso
  más claro: nunca se usa porque la búsqueda por nombre la resuelve el índice
  **GIN trigram**, no el B-tree — está duplicando trabajo con el que sí sirve.

  **Pero no los borres en bloque, y sobre todo no toques `Lead_agenteId_idx`.**
  Que tenga 0 scans no significa que sobre: significa que las consultas que lo
  usarían (`findAll` escopado por agente) hoy las hace casi siempre un ADMIN,
  que ve todo y por tanto no filtra por `agenteId`. En cuanto haya tráfico real
  de agentes, ese índice pasa a ser el que sostiene el escopado. Un índice sin
  uso es una pregunta ("¿quién debería estar usándolo?"), no una conclusión.

  Ignorá también los `_pkey` que aparecen con 0 scans en tablas de 5-20 filas:
  Postgres hace seq scan porque es más barato, y el índice sigue siendo
  obligatorio para la restricción de unicidad. Nunca son candidatos a borrar.

- **`pg_stat_statements` NO está instalada** (verificado 2026-08-26). Es la
  razón por la que este archivo no puede listar "las 5 queries más lentas": no
  hay histórico que consultar, solo `EXPLAIN ANALYZE` puntual sobre una query
  que ya sospechás. Si alguna vez hace falta diagnosticar lentitud de verdad y
  no de oído, habilitarla es el primer paso (`shared_preload_libraries`, exige
  reiniciar Postgres — que en este VPS es compartido, así que no es gratis).
- **`LIMITE_INBOX = 500` era el único problema de escala REAL del sistema.
  RESUELTO el 2026-08-27**, trece días antes de la fecha en que iba a estallar.

  Se deja escrito porque la FORMA del fallo se repite. El backend cortaba en las
  500 más recientes y **el frontend filtraba las pestañas y buscaba en memoria
  sobre ese corte**. Una conversación fuera del corte no estaba "más abajo": era
  invisible para las pestañas *y para el buscador*. La agente buscaba a una
  paciente con chat antiguo, leía "sin resultados" y concluía que no existía.
  No era degradación gradual sino un acantilado —a 499 todo bien, a 501 empiezan
  a desaparecer chats— y lo único que avisaba era un `logger.warn` que nadie
  mira. Ya había pasado una vez al cruzar las 100.

  ```
  Conversacion el 2026-08-26:           325
  Altas nuevas, 14 días (13→26 ago):    186  →  13,3/día
  (500 - 325) / 13,3  ≈  13 días        →  ~8 de septiembre de 2026
  ```

  **Qué se hizo, y por qué no fue subir el número**: las cuatro operaciones
  —ordenar, filtrar por pestaña, filtrar por agente y buscar— se movieron a
  Postgres, y el listado pasa `RespuestaPaginada` como el resto del CRM. La
  pestaña "Sin responder" necesitó una columna desnormalizada
  (`Conversacion.esperandoRespuesta`) porque "el último mensaje es ENTRANTE o
  automático" no se puede expresar en un `where` de Prisma; se escribe en las
  cuatro transacciones que crean un Mensaje, y hay tests que fijan las cuatro.

  Medido sobre 1.000 conversaciones sembradas:

  | | antes | después |
  |---|---|---|
  | Carga inicial | 500 filas · 277,7 kB · 47 ms | 50 filas · 27,8 kB · 18 ms |
  | Un mensaje nuevo (WebSocket) | recargaba las 500 · 277,7 kB | 1 fila · 0,6 kB |
  | Buscar a la paciente del puesto 1.000 | **0 resultados** | 1 resultado · 5,9 ms |

  Cubierto por `inbox-escala.integracion.spec.ts`: 499/500/501/1.000, búsqueda
  de la más antigua por nombre y por teléfono, permisos por agente y refresco de
  una sola fila.
- **N+1 en los services grandes** — auditado el 2026-08-21, línea por línea:
  `planilla-comisiones.service.ts` resuelve TODOS sus agregados en SQL dentro de
  una sola `$transaction` (`aggregate` + dos `groupBy` en `listarVentas`), y el N+1
  que sí tuvo `calculo-comisiones.service.ts` (dos queries por vendedora en el
  bucle de bonos) ya está resuelto con una sola consulta de equipo — el comentario
  del propio código lo documenta. El `findMany` sin `take` de `calcular()` es a
  propósito: el motor de liquidación necesita las filas del periodo en memoria
  (~500/mes; tabla entera: 1.287), no es un listado de API. `reporteConsolidado`
  suma en JS sobre las ~5 filas que ya devuelve: trivial, no vale moverlo.
  Cerrado: no re-auditar sin una razón nueva.
- **Exportación y parseo de Excel** — verificado el 2026-08-21:
  `exportacion-comisiones.service.ts` ya escribe en **streaming** por lotes de
  1.000 filas (el libro nunca se materializa entero en memoria). Queda como
  candidato a `worker_thread` solo si el parseo de importación se vuelve
  perceptible con planillas mucho más grandes.
- **`connection_limit=25`** en `DATABASE_URL`: nunca vi ese número puesto a
  prueba bajo carga real concurrente. Si el número de agentes conectados a la
  vez crece, vale confirmar que 25 conexiones alcanzan sin que Prisma empiece a
  esperar turno (`pool_timeout=10` significa que a partir de ahí las queries
  fallan, no solo se hacen lentas).
- **La carga real, medida** (2026-09-02, sobre 7 días de `LoggingInterceptor`
  en el journal). Antes de optimizar nada de este módulo, mirá estos números,
  porque cambian el diagnóstico:

  ```
  1.580 peticiones en 7 días  (~9 por hora)   ·   0 errores 4xx/5xx
  ```

  Los endpoints más lentos, por promedio:

  | endpoint | n | prom | máx |
  |---|---|---|---|
  | `GET /kpis/resumen` | 64 | 410 ms | 963 ms |
  | `GET /planilla-comisiones/periodos/:id/analitica` | 27 | 397 ms | 958 ms |
  | `POST /auth/login` | 21 | 336 ms | 498 ms |
  | `GET /conversaciones` | 242 | 108 ms | 910 ms |

  El login a 336 ms es bcrypt en un solo núcleo: es su precio, no un bug.

  **Y del lado de la base, nada.** Postgres tiene `log_min_duration_statement =
  500` desde antes, o sea que viene registrando toda query lenta: en el último
  mes hay **exactamente tres**, y las tres son los `COPY` de los propios
  `pg_dump` de respaldo. **Ninguna consulta de la aplicación pasó de 500 ms.**
  Conclusión honesta: hoy este sistema no tiene un problema de rendimiento.
  Optimizar el código sería resolver lo que no duele.

- **Sigue sin haber profiling de CPU/event-loop**: lo de arriba es latencia
  extremo a extremo, que dice *cuánto* tarda pero no *dónde*. Si algún día hace
  falta saberlo, el paquete npm `clinic` (Clinic.js) o `0x` para CPU/event-loop y
  `autocannon` para carga HTTP. Optimizar sin medir es tan fácil de hacer para el
  lado equivocado como de hacerlo bien.
- **Swagger/OpenAPI sigue sin existir** — no es "velocidad", pero si algún día
  se conecta un tercero o cambia el equipo, ayuda. `kpis`, `usuarios` y `auth`
  **ya tienen suite unitaria** (2026-08-25), cerrando el hueco que este mismo
  punto señalaba: `kpis.service.spec.ts` fija el escopado por agente
  (`kpis.service.ts` es justo donde ya hubo una fuga real de datos entre
  agentes, ver `crm-backend-module`) y que la caché no sirva el resumen de un
  agente a otro; `usuarios.service.spec.ts` fija la protección del último
  `SUPER_ADMIN` activo y que nadie se toque sus propios privilegios;
  `auth.service.spec.ts` fija que `refresh()` solo dé 401 por un problema real
  de credenciales, nunca por un fallo transitorio de la base. `leads` **ya
  tenía** `leads.integracion.spec.ts` (2026-08-21): la falta de tests ahí no
  era solo hipotética — escondía el bug de escopado que describe
  `crm-backend-module` §"La regla de findAll…", y las pruebas nuevas son
  justamente las que lo hubieran atrapado antes de producción. Mismo
  razonamiento detrás de las tres suites nuevas.

## 8. Antes de dar por terminada cualquier tarea de este tipo

- `npm run build` (incluye `check:skills`) sin errores.
- `npm test` (350 tests en 21 suites, 2026-08-26) en verde.
- Si tocaste algo con lógica de negocio real (no solo observabilidad/infra):
  `npm run test:integracion:preparar && npm run test:integracion` contra
  Postgres real — necesita un Postgres en `:5433`. Si no hay uno a mano, se
  levanta uno descartable sin Docker ni systemd, como usuario normal (probado
  el 2026-08-27; antes esto decía "ver el historial de aquel chat", que es un
  puntero a nada):

  ```bash
  PG=/usr/lib/postgresql/16/bin          # los binarios están aquí aunque no haya servicio
  DATA=/tmp/pgdata-crm                   # cualquier ruta escribible
  $PG/initdb -D "$DATA" -U crm_app --auth=trust -E UTF8
  $PG/pg_ctl -D "$DATA" -o "-p 5433 -k /tmp -c listen_addresses=localhost" -l "$DATA/log" start
  psql -h localhost -p 5433 -U crm_app -d postgres -c "ALTER USER crm_app PASSWORD 'crm_dev_local';"
  # …trabajar…
  $PG/pg_ctl -D "$DATA" stop              # y borrar $DATA cuando sobre
  ```

  `--auth=trust` es aceptable porque escucha solo en loopback y muere con el
  directorio; la contraseña se fija igual porque es la que traen cableada las
  suites (`crm_app:crm_dev_local`). Vale la pena montarlo aunque sea para una
  sola prueba: sin base real, "compila" es todo lo que se puede afirmar.
- Si el cambio va a producción: seguir §4 completo, sin saltarse el backup ni
  la verificación posterior. "Compiló" no es "funciona" — este proyecto lo
  usan agentes reales sobre datos de pacientes reales, todos los días, sin red
  de staging debajo.

## 9. Qué cambió en la máquina el 2026-09-02

Una sesión de optimización sobre el servidor, no sobre el código. Se anota acá
porque nada de esto vive en el repo: si no está escrito, el próximo que entre no
tiene forma de enterarse. **Ningún cambio tocó el backend ni la base de datos**
salvo un `ANALYZE` y el pool de conexiones.

El punto de partida fue medir, y la medición cambió el plan: no había problema
de rendimiento (§7), así que lo que se corrigió fue desperdicio, exposición y
falta de red de seguridad.

| Cambio | Dónde | Efecto medido |
|---|---|---|
| `fail2ban` instalado y activo | `/etc/fail2ban/jail.local` | ataque SSH ~100x menos (§6) |
| Respaldo diario automático | `/usr/local/sbin/backup-crm.sh`, `/etc/cron.d/backup-crm` | cerró un hueco de 4 días (§4) |
| Pool de Prisma 25 → 10 | `DATABASE_URL` en `.env` | 25 conexiones ociosas → 1, ~69 MB (§2) |
| Techo de concurrencia a Apache | `/etc/httpd/conf.d/zz-limites-vps.conf` | 400 → 150 workers |
| Tope al journal de systemd | `/etc/systemd/journald.conf.d/99-limite.conf` | `SystemMaxUse=200M` |
| Rotado por tamaño de `secure`/`messages` | `/etc/logrotate.d/99-secure-tamano` | rota a los 50 MB |
| `ANALYZE` de toda la base | — | `Lead` no tenía estadísticas completas |
| `agenda-api` detenido y deshabilitado | — | tercer proyecto, decisión del dueño (§2) |
| 1,7 GB de disco liberados | — | 56 % → 50 % de 30 GB |

Tres detalles que valen para la próxima:

- **`MaxRequestWorkers` estaba en el default de 400.** En 1.7 GB compartidos eso
  no es capacidad disponible: es la forma en que un pico o un escáner consume
  toda la RAM y se lleva puestas las tres aplicaciones. El techo nuevo, 150, es
  un orden de magnitud más de lo que este servidor ha visto (§7).

- **El `ANALYZE` no fue cosmético.** `Lead` (15.665 filas) nunca había tenido un
  `autoanalyze` —el umbral es 50 + 10 % de las filas, y una tabla cargada de
  golpe y luego casi quieta no lo cruza nunca— y `Cliente` traía estadísticas
  del 1 de agosto. El planificador estaba eligiendo planes a ciegas sobre las
  dos tablas más grandes. Vale re-correrlo después de cualquier importación
  masiva; `autovacuum` solo no alcanza en tablas que se cargan de una vez.

- **De los 1,7 GB liberados, 900 MB eran el log del ataque de fuerza bruta** y
  731 MB un instalador de `scriptcase` en `/home` que nunca se había instalado
  (verificado: sin rastro en el sistema, sin vhost ni servicio que lo
  referenciara). El disco no era el problema, pero el log sí era un síntoma.

Lo que se decidió NO tocar, y por qué: `webmin` y `vsftpd` quedan encendidos
porque el dueño los usa para otro software (FTP/PDF), y **MySQL sigue escuchando
en `0.0.0.0:3306` con el puerto abierto en `firewalld`** — se planteó como
riesgo y el dueño resolvió dejarlo así. Queda anotado sin cerrar: el chequeo de
usuarios remotos de MySQL quedó inconcluso (el cliente `mysql` no autenticó), o
sea que **no hay evidencia de que esté a salvo, solo la decisión de no tocarlo**.

## 10. Vínculos

- `CLAUDE.md` (raíz del repo) — invariantes del día a día, trampas conocidas
  (comisiones en dólares, notificaciones, caché).
- `crm-backend-module` (skill hermano) — patrón de módulo: paginación, roles,
  DTOs, concurrencia, webhooks, migraciones.
- `MANUAL-COMISIONES.md` — el negocio detrás del módulo de comisiones.
- `CRM_MANIFESTO.md` (repo del frontend) — arquitectura que gobierna ambos repos.

## Mantenimiento de este archivo

A diferencia de `crm-backend-module`, `check:skills` no verifica los datos de
infraestructura de este archivo (IPs, RAM, nombres de servicio) porque viven
fuera del repo — nadie los va a detectar desincronizados automáticamente. Si
el servidor cambia (más RAM, otra máquina, otro proveedor), **actualizá este
archivo a mano** en el mismo cambio, o se vuelve la misma clase de mentira
silenciosa que `check:skills` existe para evitar en el resto de los skills.
