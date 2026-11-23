# 2. Infraestructura registrada — verificar antes de operar

> Parte de la skill `crm-backend-arquitectura`: lee antes su [índice](../SKILL.md).

> **Migrado el 2026-09-17.** Hasta esa fecha esto era un VPS AlmaLinux de **un
> núcleo y 1,7 GB** en `107.172.193.34`, compartido con MySQL y dos backends
> ajenos (`dulce_espera`, `agenda_api`). Ya no. Si encontrás documentación,
> scripts o razonamientos que hablen de `httpd`, de `dnf`, de un solo núcleo o
> de 400 MB de techo, están describiendo la máquina vieja.

**Desde el 2026-09-21 ya NO está dedicado a este CRM.** El portal de Resultados
Montalvo se desplegó en la misma máquina: tres servicios propios
(`resultados-api` en :3010, `resultados-portal` en :3011, `resultados-worker`),
su propia base en el mismo Postgres, un vhost de Apache aparte y **ClamAV**, que
es el vecino que de verdad pesa —analiza cada PDF que sube un médico, con
límites acordes a archivos de hasta 10 MB—. Sigue sobrando margen (medido el
2026-09-22: ~2,0 GB usados de 7,9 GB, disco al 29 %), pero antes de decir "esta
máquina es solo nuestra" o de dimensionar algo contra la RAM total, contá al
vecino. Los dos productos son independientes: no comparten base, usuarios ni
sesiones, y se hablan por loopback con una credencial de solo lectura (ver
`modules/resultados/`).

Inventario registrado tras la migración y la llegada de Resultados. Las
cifras del bloque de RAM/disco son anteriores a ese vecino, no una medición actual:

```
$ nproc && free -h && df -h /
4                                     ← 4 vCPU
              total   used   disp
Mem:          7.8Gi   793Mi  7.0Gi    ← medición histórica del 18/09, antes de Resultados
/dev/…          59G    12G   (22%)

$ systemctl list-units --type=service --state=running
crm_backend.service          ← este backend
apache2.service              ← Debian usa "apache2", no "httpd"
postgresql@16-main.service   ← Postgres 16.14, con la base del CRM y la de Resultados
resultados-api.service       ← portal de resultados (vecino, :3010)
resultados-portal.service    ← su Next (vecino, :3011)
resultados-worker.service    ← su cola de avisos y purga horaria
clamav-daemon.service        ← antivirus de los PDF del vecino
fail2ban.service
apache-htcacheclean.service
qemu-guest-agent.service
```

- **OS**: Debian GNU/Linux 12 (bookworm), kernel 6.1.0-31-amd64.
- **CPU**: Intel Xeon E5-2697 v2 @ 2.70 GHz.
- **Node / npm**: `v22.23.1` / `10.9.8`, acorde con `engines.node >= 22`.

**Lo que sigue siendo verdad y lo que ya no.**

El 18/09, antes de Resultados, se midieron load 0,00, Node al 1 % y 280 MB,
y Postgres con 99,94 % de cache hit. Desde el 21/09 comparte recursos con
Resultados y ClamAV. Esas mediciones no prueban la carga ni el margen actuales;
medir el incidente concreto antes de dimensionar u optimizar.

Sigue siendo verdad que **Node atiende las peticiones en un solo hilo**: cualquier
trabajo síncrono pesado en el event loop —parsear un Excel con `exceljs`, un
`JSON.stringify` enorme— bloquea a todas las agentes conectadas a la vez. Los 4
núcleos no lo salvan, porque el proceso no usa más de uno para eso.

Y hay un hecho nuevo, medido en R3 el 2026-09-18, que conviene tener presente
antes de culpar al código: **este Xeon de 2013 con DDR3 es unas 11 veces más
lento que una máquina moderna en trabajo de asignación de objetos y GC** (142 ms
contra 13 ms en el mismo benchmark). En cómputo puro de enteros va parejo — por
eso un benchmark de CPU engaña—. Lo que eso significa en la práctica: el coste
de `GET /conversaciones` no está en el SQL (menos de 5 ms) sino en materializar
las filas en objetos JavaScript. **Traer menos filas vale mucho más acá que en
un servidor moderno.** Ver el [informe de R3](../../../../docs/rendimiento-r3-2026-09.md).

`crm_backend.service` (`systemctl cat crm_backend` en el servidor):

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
SyslogIdentifier=crm_backend

# Endurecimiento
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/crm-backend

MemoryMax=1500M
```

**`MemoryMax=1500M` es un techo real**: si Node lo supera, systemd lo mata y
`Restart=always` lo revive — una caída, no una degradación. Con 280 MB en marcha
hay margen de sobra, pero el techo existe para que una fuga o un `findMany` sin
`take` se lleven por delante el proceso y no la máquina entera. Es la misma razón
de fondo de "todo listado se pagina" y del tope de entradas de
`common/cache/cache-memoria.ts`.

### El reverse proxy (Apache)

`/etc/apache2/sites-available/crm_backend-le-ssl.conf` en el servidor (resumido):

```apache
<VirtualHost *:443>
    ServerName crm.107.175.132.15.nip.io
    Protocols h2 http/1.1              # HTTP/2 solo navegador↔Apache
    ProxyPreserveHost On

    # Upgrade a WebSocket para el inbox de Conversaciones (socket.io)
    RewriteCond %{HTTP:Upgrade} =websocket [NC]
    RewriteRule ^/socket.io/(.*) ws://127.0.0.1:3001/socket.io/$1 [P,L]
    ProxyPass /socket.io/ http://127.0.0.1:3001/socket.io/
    ProxyPassReverse /socket.io/ http://127.0.0.1:3001/socket.io/

    ProxyPass / http://127.0.0.1:3001/
    ProxyPassReverse / http://127.0.0.1:3001/

    SSLCertificateFile /etc/letsencrypt/live/crm.107.175.132.15.nip.io/fullchain.pem
</VirtualHost>
```

- El dominio es un **`nip.io`** (DNS wildcard que resuelve al propio IP): no hay
  un dominio propio comprado para el backend. El frontend sí puede tener el suyo
  en Vercel — son cosas independientes.
- `main.ts` confía en el proxy solo si es loopback (`app.set('trust proxy', 'loopback')`):
  así `req.ip` toma la IP real del `X-Forwarded-For` que agrega Apache, y el
  rate-limit por IP funciona de verdad. Ver `crm-backend-module` para el porqué.

### Postgres

El servidor PostgreSQL aloja bases separadas de CRM y Resultados. La agenda
usa MySQL en otro VPS, no la base del CRM. `max_connections = 100`
a nivel servidor (medición histórica). Desde Prisma 7, `PrismaService` configura
el adaptador `pg`: `max: 10`, `connectionTimeoutMillis: 5000` e
`idleTimeoutMillis: 120000`. Los parámetros del antiguo motor en `DATABASE_URL`
no configuran ese pool.

**Ese 10 era 25 hasta el 2026-09-02**, y bajarlo fue una de las optimizaciones de
ese día. Prisma mantiene el pool abierto aunque nadie lo use: había **25 conexiones
ociosas permanentes** —la más vieja llevaba 6 horas sin una sola query— que
costaban **69 MB de memoria privada**, medidos con `smaps_rollup`, sobre los
1,7 GB que tenía la máquina de entonces. Para un backend que sirve ~1.580 peticiones
por semana (§7), 10 sigue siendo holgado: la recomendación de Prisma es `núcleos * 2 + 1`, o sea 9 con los 4 de hoy. Tras el cambio `pg_stat_activity` pasó de
25 conexiones a 1.
