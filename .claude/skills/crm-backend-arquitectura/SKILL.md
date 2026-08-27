---
name: crm-backend-arquitectura
description: Mapa completo del backend — infraestructura real de producción (VPS compartido, systemd, Apache/httpd, Postgres), cómo desplegar paso a paso, la escala real de datos, qué decisiones de arquitectura ya están tomadas y por qué, y dónde mirar para rendimiento/escalabilidad. Úsalo para cualquier tarea que no sea "tocar un endpoint" — desplegar, diagnosticar lentitud o un incidente, decidir si algo escala, entender por qué el servidor está configurado así, u orientarte la primera vez que trabajas en este repo. Para el patrón de código de un módulo (paginación, roles, DTOs, webhooks) usa `crm-backend-module`; este skill es el contexto de alrededor.
---

# Mapa del backend — CRM Clínica Montalvo

Esto es lo que un agente nuevo (o vos mañana, sin memoria de hoy) necesita para no
perderse: dónde vive cada cosa, en qué máquina real corre, cuánta gente y cuántos
datos hay de verdad, qué ya está resuelto, y dónde mirar si hay que hacerlo más
rápido o más grande. Todo lo que sigue lo verifiqué contra el servidor real el
2026-08-21, no es una descripción de memoria — donde algo pueda haber cambiado, lo digo.

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
agenda-api.service             ← FastAPI, otro proyecto
dulce_espera_backend.service   ← FastAPI, otro proyecto
mysqld.service                 ← MySQL 8, lo usan los otros dos
postgresql.service             ← Postgres, SOLO lo usa este CRM
httpd.service                  ← Apache (RHEL usa "httpd", no "apache2")
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

Solo esta app lo usa (MySQL es de los otros dos proyectos). `max_connections = 100`
a nivel servidor; Prisma se conecta con `connection_limit=25&pool_timeout=10` en
`DATABASE_URL` — margen real para picos, sin acercarse al techo del servidor.

## 3. Escala real de datos (medida en producción, no estimada)

Remedido el **2026-08-26** (`pg_stat_user_tables`); entre paréntesis, lo que
había el 2026-08-21, para que se vea la pendiente y no solo la foto:

```
Lead            15.620  (15.552)
Cliente         15.608  (15.542)   33 MB — 21 MB tabla + 11 MB índices
Mensaje          2.186   (1.659)   ← +32 % en cinco días
VentaImportada   1.287   (1.287)
AuditLog           473     (375)
Conversacion       325     (257)   ← +26 % en cinco días
Venta                3       (0)
```

**Las dos que crecen rápido son justo las del inbox**, y eso cambia una
conclusión que este archivo daba por cerrada (ver §7, `LIMITE_INBOX`). Las dos
tablas grandes, en cambio, están planas: `Cliente` y `Lead` sumaron ~66 filas
cada una en esos cinco días (+0,4 %). Las grandes no crecen; las chicas sí.

`TipoCambioDiario` (módulo `tipo-cambio`, agregado después de esta medición)
no está en la tabla: es un valor por día, así que su techo natural es ~365
filas/año aunque nunca se pierda una sincronización — no hace falta remedirlo
para saber que no es un problema de escala.

Base completa: **58 MB**. Esto importa para calibrar cualquier conversación sobre
"performance": **no es un problema de volumen de datos** — 58 MB entra entero en
RAM varias veces. El cuello de botella de este sistema es la máquina de un solo
núcleo y 1.7 GB compartidos (§2), no el tamaño de las tablas. Optimizar asumiendo
un problema de "big data" que no existe sería resolver lo que no duele.

`Venta` en cero es una señal a verificar, no asumir: puede ser que el flujo real
de ventas viva todavía en `VentaImportada` (el Excel de comisiones) y el módulo
`Ventas` sea nuevo/en migración. Confirmar con quien conoce el negocio antes de
tratarlo como código muerto.

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

**Por qué el backup se verifica y no se asume**: la primera vez que desplegué
así, `pg_dump -U postgres crm` sin la contraseña correcta falló en silencio
(`2>/dev/null` se come el error) y el gzip resultante tenía **20 bytes** — un
backup vacío que parecía exitoso. `ls -la` del archivo y confirmar que pesa MB,
no bytes, es lo único que lo hubiera atrapado antes de necesitarlo.

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

**Corolario para la verificación**: `is-active` + `/health` + 400/401 **no
prueban que el deploy ocurrió** — prueban que el proceso está sano, sea cual
sea el código que corre. Lo que sí lo prueba son estas dos líneas:

```bash
date -r /opt/crm-backend/dist/main.js                      # ¿se recompiló recién?
systemctl show crm_backend.service -p ActiveEnterTimestamp # ¿arrancó después?
```

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

  **Lo que sigue abierto, y ahora con números** (`sshd -T`, 2026-08-26):

  ```
  permitrootlogin yes
  passwordauthentication yes    ← contraseña de root, expuesta a internet
  pubkeyauthentication yes
  fail2ban: inactive
  ```

  El banner del login reporta **82.723 intentos fallidos** desde el último
  acceso exitoso. La llave ya existe, así que `passwordauthentication no` no
  rompería el despliegue — deja fuera al ataque por fuerza bruta sin costo. Un
  `fail2ban` activo sería el segundo paso. Endurecer esto no es hipotético:
  es una puerta que ya está siendo golpeada 80 mil veces entre logins.
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
- **`LIMITE_INBOX = 500` es el único problema de escala REAL del sistema, y
  tiene fecha estimada de vencimiento: ~8 de septiembre de 2026.** Ya no es un
  "vale revisar algún día" — esa era la redacción de este archivo hasta el
  2026-08-26, cuando se midió el crecimiento y dejó de ser hipotético:

  ```
  Conversacion hoy (2026-08-26):        325
  Tope del inbox:                       500
  Margen:                               175
  Altas nuevas, 14 días (13→26 ago):    186  →  13,3/día  (rango 4–23)
  175 / 13,3  ≈  13 días
  ```

  **Qué pasa exactamente al cruzarlo**, según el comentario del propio
  `conversaciones.service.ts` (que ya lo vivió una vez "al cruzar las 100"): el
  backend corta en las 500 más recientes por `updatedAt` y **el frontend filtra
  las pestañas y busca en memoria sobre lo que recibió**. Así que una
  conversación fuera del corte no es solo "está más abajo en la lista": es
  invisible para las pestañas *y para el buscador*. Una agente que busque a una
  paciente con un chat antiguo obtiene cero resultados y concluye que no existe.

  No es degradación gradual, es un acantilado: a 499 conversaciones todo
  funciona, a 501 empiezan a desaparecer chats en silencio. Lo único que avisa
  es un `logger.warn` que nadie está mirando.

  Paginar de verdad exige mover pestañas y búsqueda al servidor — por eso se
  difirió, y la razón sigue siendo válida. Lo que cambió es que ahora hay una
  fecha. Subir el número a 2.000 es un parche de una línea que compra ~4 meses;
  la solución real es servidor-primero. Elegir a conciencia, no por defecto.
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
- **No hay ningún profiling real hecho**: todo lo de arriba es lectura de
  código e infraestructura, no medición. Antes de optimizar cualquiera de estos
  puntos, medí con algo real contra el propio servidor o una réplica — el paquete
  npm `clinic` (Clinic.js) o `0x` para CPU/event-loop, `autocannon` para carga
  HTTP, y las vistas de
  Postgres (`pg_stat_statements` si está habilitada) para las queries más lentas
  de verdad. Optimizar sin medir es tan fácil de hacer para el lado equivocado
  como de hacerlo bien.
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
  puede levantar uno descartable sin Docker ni systemd (`initdb` + `pg_ctl` de
  usuario, ver el historial de este chat del 2026-08-20 para la receta exacta).
- Si el cambio va a producción: seguir §4 completo, sin saltarse el backup ni
  la verificación posterior. "Compiló" no es "funciona" — este proyecto lo
  usan agentes reales sobre datos de pacientes reales, todos los días, sin red
  de staging debajo.

## 9. Vínculos

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
