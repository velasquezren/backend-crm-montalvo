# R3 — Rendimiento y latencia · PASO 2 HECHO, INFRAESTRUCTURA MEDIDA

**Estado: parado a propósito el 18 de septiembre de 2026, antes de implementar nada.**
No se tocó código de producción, no hay cambios de rendimiento commiteados y no se
desplegó nada. Lo único que este trabajo dejó en Git es este informe.

Se para aquí porque el despliegue de R2.2 sigue bloqueado (sin acceso SSH al VPS) y
porque el diagnóstico automático se cortó a mitad de su fase de verificación: hay
mediciones sólidas y hay pistas sin comprobar, y mezclarlas sería exactamente lo que
`crm-rendimiento` prohíbe.

## Lo que sí está medido

Todas las cifras de abajo se tomaron el 17–18/09/2026 **desde Santa Cruz de la Sierra
(COTAS)**, es decir desde la misma red que usa la clínica, no desde el servidor ni
desde un laboratorio. Método: `curl -w` con `time_namelookup`, `time_connect`,
`time_appconnect`, `time_starttransfer` y `time_total`, 10–12 muestras por medición,
percentiles calculados en Python (ojo con `awk` y la coma decimal del locale es_BO:
devuelve ceros en silencio).

### API en frío — conexión nueva

| Tramo | p50 | p95 | min | max |
| --- | ---: | ---: | ---: | ---: |
| DNS | 3,8 ms | 6,8 ms | 3,4 | 182,6 |
| TCP connect | 141,7 ms | 189,6 ms | 138,3 | 190,3 |
| TLS handshake | 152,1 ms | 206,6 ms | 144,9 | 207,7 |
| servidor → primer byte | 154,7 ms | 196,1 ms | 143,6 | 235,8 |
| **TOTAL** | **495,1 ms** | **594,6 ms** | 433,9 | 630,9 |

### API en caliente — conexión reutilizada

Seis peticiones sobre la misma conexión, tres rondas: la primera paga
`connect 145 ms + TLS 150 ms`; **de la segunda en adelante, 143–202 ms, mediana
≈ 148 ms**, que es un RTT y nada más.

Se confirmó además que el API **negocia HTTP/2** (`http_version=2` en todas las
muestras) y que reutiliza conexión correctamente (`num_connects=0` a partir de la
segunda petición del mismo proceso).

### Frontend (Vercel)

| | p50 | p95 |
| --- | ---: | ---: |
| `index.html` en frío (DNS 4 + TCP 40 + TLS 109 + servidor 101) | 297,3 ms | 388,1 ms |
| 12 recursos del primer pintado, 124,1 kB brotli, una conexión | ~290 ms | 367 ms |

Vercel sirve desde **gru1 (São Paulo)** con `x-vercel-cache: HIT` y `content-encoding: br`.

## El cuello de botella, en una frase

**El servidor no aporta casi nada al tiempo que percibe la agente: lo que se paga es
el viaje y, sobre todo, abrir la conexión.** Una petición en caliente cuesta 148 ms;
la primera cuesta 495 ms. Los ~295 ms de diferencia son TCP + TLS, dos RTT que hoy se
pagan *después* de que Angular arranque.

Esto confirma, con números de la clínica, lo que ya decía la auditoría anterior: **no
estamos CPU-bound**. El tramo «servidor → primer byte» (154,7 ms) es esencialmente el
RTT; el trabajo real del backend se pierde dentro del ruido de la red.

## Lo único CONFIRMADO, y listo para implementar

**No existe `preconnect` al origen del API.** El `index.html` declara preconnect a
`fonts.googleapis.com` y `fonts.gstatic.com` y a nada más — comprobado en el fuente
(`frontend/src/index.html:27-28`) y en el HTML servido en producción. La primera
petición al API (`GET /auth/perfil`, que dispara `provideAppInitializer`) abre la
conexión desde cero cuando el bundle ya terminó de descargarse.

La aritmética que lo justifica, con las mediciones de arriba:

```
bundle listo en           ~290 ms  (12 recursos, 124,1 kB br, conexión a São Paulo)
handshake al API cuesta   ~295 ms  (TCP 142 + TLS 152, conexión a Buffalo)
```

Las dos ventanas son casi idénticas, así que un `preconnect` declarado en el `<head>`
mueve el handshake a que ocurra **en paralelo** con la descarga del bundle en vez de
después. No ahorra trabajo: lo adelanta. El techo de la mejora es el handshake
entero, ~295 ms sobre un arranque en frío de ~790 ms.

Este hallazgo sobrevivió a un verificador adversarial que intentó refutarlo y no pudo:
comprobó el fuente, el HTML de producción y que no exista ninguna decisión previa que
lo haya descartado.

**Detalle asociado, también confirmado:** el `preconnect` a `fonts.googleapis.com` está
muerto. El build de Angular inlinea el CSS de Google Fonts en el `index.html`
(`@font-face` embebido), así que a ese host no se le pide nada nunca; los ficheros de
fuente sí salen de `fonts.gstatic.com`, cuyo preconnect sí sirve. Hoy se abre un
handshake TLS completo para tirarlo a la basura, justo en la ventana en la que el
navegador debería estar abriendo el del API.

**Cómo medirlo cuando se implemente**, sin navegador: comparar el coste del handshake
frío (`curl -w '%{time_appconnect}'` contra el origen del API) con el tiempo de
descarga del bundle servido por Vercel. La mejora esperada es que el primer
`GET /auth/perfil` pase de pagar ~445 ms a pagar ~148 ms.

## La geografía: medida, y con una sorpresa

RTT real (TCP connect) desde Santa Cruz, mediana de 5 muestras:

| Destino | RTT |
| --- | ---: |
| **VPS actual · Buffalo, NY** | **141 ms** |
| Vercel edge · São Paulo | 40 ms |
| Vultr · Santiago de Chile | 83 ms |
| Linode · Atlanta | 125 ms |
| Vultr · São Paulo | 133 ms |
| Linode · Newark | 134 ms |
| Linode · Dallas | 145 ms |
| Vultr · Ciudad de México | 156 ms |

**La conclusión no es «mover el servidor al sur».** Vultr en São Paulo da 133 ms —
prácticamente lo mismo que Buffalo — mientras que el edge de Vercel, también en São
Paulo, da 40 ms. Lo que domina no es la distancia sino el **peering de COTAS con cada
red**. El único candidato de hosting convencional que mejora de verdad es Santiago de
Chile: −58 ms en *cada* viaje, lo que convertiría los 148 ms en caliente en ~90 ms.

Esto es investigación, **no una propuesta de migración**. Antes de mover nada habría
que medir el proveedor y la región concretos desde varias conexiones de la clínica y
en distintas horas.

## Pistas SIN VERIFICAR — no implementar tal cual

Un diagnóstico automático recorrió ocho dimensiones y se detuvo durante la fase de
verificación adversarial. **Solo la dimensión de preconnect llegó a verificarse.** Lo
que sigue son pistas que valen para orientar la siguiente sesión, no hallazgos.

> **Aviso que importa más que la lista:** de los cuatro hallazgos que sí llegaron a
> verificarse, **tres fueron refutados**, y uno de ellos citaba números de línea que
> no existen (`token.interceptor.ts:133-135` cuando el archivo tiene 101 líneas;
> `api.constants.ts:130-132` cuando tiene 23). Cualquier pista de esta sección se abre
> y se comprueba en el código antes de tocarla.

Por dimensión, lo que quedó apuntado:

- **Arranque.** `provideAppInitializer` dispara `GET /auth/perfil` como primera
  petición; el layout lanza `GET /tipo-cambio/vigente` y la campana
  `GET /actividades/resumen`. Pista: el `GET /conversaciones` no puede salir hasta que
  el chunk lazy del inbox está descargado y parseado. Pista: la agente aterriza en
  `/dashboard` (`app.routes.ts`), lo que suma un `GET /kpis/resumen` y una navegación
  antes de llegar al inbox, que es donde trabaja.
- **Apertura de conversación.** Pista: `POST /:id/leido` sale en cada apertura aunque
  el chat ya estuviera leído; `GET /plantillas-agente` se repide en cada cambio de
  conversación aunque la respuesta sea idéntica; volver a una conversación recién
  abierta vuelve a pagar el `GET /conversaciones/:id` entero.
- **Realtime.** Pista: cuando el aviso de socket es del chat abierto, dispara tres
  peticiones (resumen + detalle completo + `POST /leido`) en vez de una; el respaldo de
  60 s de la campana no se apaga con el socket vivo ni con la pestaña oculta; un tic de
  entrega recarga los 50 mensajes del hilo.
- **Filtros del inbox.** El núcleo está bien (un solo `computed`, descarte por
  `filtros !== this.filtros()`). Pista: el buscador de «Mi Memoria» no tiene debounce —
  una petición por tecla; llegar desde Clientes con `?telefono=` paga los 300 ms del
  debounce del teclado sin necesidad.
- **Round trips.** Pista: dentro de `findAll` del inbox, la página y los contadores son
  dos transacciones en serie que no dependen entre sí; `enviarMensaje` serializa dos
  lecturas independientes antes de escribir. Son milisegundos de servidor, no de red:
  con 148 ms de RTT, casi nada de esto se nota.
- **Bundle.** 12 archivos, 408.080 B brutos / 107.388 B brotli; el 87 % es framework
  (`@angular/core`, `router`, `common`). Pista: el layout arrastra `socket.io-client`
  (12,8 kB br) por import estático de la campana; el Service Worker se registra con
  `registerImmediately` y precarga 86 archivos / 458 kB encima del login.
- **Transporte.** Sin resultado: el agente de esta dimensión se reinició y no llegó a
  entregar. Lo que interesaba de ella ya está medido a mano más arriba (HTTP/2,
  reutilización de conexión, brotli en Vercel).

### Refutado — no volver a proponerlo

| Pista | Por qué NO |
| --- | --- |
| «Las llamadas de push cuestan 384 ms en cada entrada al inbox» | Van con `void`: nada las espera. Y al ir por HTTP/2 se multiplexan sobre la misma conexión que `GET /conversaciones`. Las peticiones existen; la latencia atribuida, no |
| «Cada escritura vacía la caché de referencia y cuesta tres viajes» | El mecanismo es real (`cache.interceptor.ts` borra el Map entero ante cualquier método ≠ GET), pero dos de los tres viajes que decía ahorrar no existen |
| «Cada URL nueva paga un preflight OPTIONS en serie» | Citas inexistentes (líneas más allá del EOF). El fondo es cierto —es cross-origin y hay preflight— pero la respuesta trae `access-control-max-age: 86400`, así que el navegador lo cachea un día: no es un coste por URL y por sesión |

## Lo que NO se pudo medir, y por qué

- **Nada desde dentro del servidor.** El VPS nuevo solo acepta clave pública por SSH y
  esta máquina no está autorizada, así que no hay CPU de Node, CPU de Postgres, load,
  event loop, memoria, configuración de Apache (Brotli/gzip para el API, keep-alive,
  TLS session reuse) ni journal. Todo eso queda pendiente.
- **Nada con sesión iniciada.** Sin credenciales de la aplicación no se midieron los
  endpoints reales del camino caliente (`/conversaciones`, detalle, `/kpis/resumen`):
  las mediciones usan `/health` (200) y rutas protegidas sin token (401), que sirven
  para la red pero no para el trabajo del backend.
- **Nada en navegador.** La regla del proyecto lo prohíbe, así que no hay waterfall
  real, ni First Contentful Paint, ni confirmación empírica de que el `preconnect` se
  solape como dice la aritmética. Se mide con `curl` y se acepta el límite.
- **Compresión del API**: no verificable desde fuera con las rutas disponibles, porque
  las respuestas públicas (94 B y 120 B) están por debajo del umbral en el que
  `compression()` actúa.

## Cuando se retome

1. Desbloquear el SSH y **cerrar R2.2** (desplegar backend `1692069`, verificar, y solo
   entonces empujar el frontend). R3 no debería empezar antes.
2. Implementar el `preconnect` al origen del API y quitar el muerto de
   `fonts.googleapis.com`. Es un cambio de dos líneas en `src/index.html`, reversible,
   y es el único con evidencia suficiente hoy. Medir antes y después con el método de
   arriba y poner los dos números en el commit.
3. Medir desde el servidor lo que falta (CPU, event loop, Apache) antes de tocar nada
   de infraestructura.
4. Verificar una por una las pistas de arriba **abriendo el código**, y descartar sin
   pena las que no resistan: ya se refutaron tres de cuatro.

**Lo que no hay que hacer:** clustering de Node, Redis, CDN delante del API, tuning de
PostgreSQL sin evidencia, ni volver a diferir el calendario de Actividades con
`@defer` —eso ya se probó, falló en producción y está revertido—.

---

*Informe de una fase detenida. No describe ningún cambio aplicado: describe qué se
midió, qué se confirmó y qué queda por comprobar.*

---

## Continuación del 18/09/2026 · medido DESDE el servidor

El bloqueo de SSH que paró la fase anterior ya no existe: `1692069` está
desplegado y esta máquina sí tiene acceso. Lo que sigue se midió desde dentro
del VPS, que es justo lo que faltaba.

### El servidor está ocioso, y ahora consta

```
4 vCPU · 7.940 MB RAM · 798 MB usados · 7.143 MB disponibles
load average  0,00 / 0,02 / 0,00
Node          1,0 % CPU · 272 MB RSS
PostgreSQL    3 conexiones · cache hit ratio 99,94 % · shared_buffers 128 MB
```

Queda cerrada la duda de fondo: **no hay nada que optimizar en el servidor.**
Cualquier propuesta de clustering, Redis o tuning de PostgreSQL tendría que
explicar antes qué recurso cree que está saturado, porque ninguno lo está.

### Compresión del API: RESUELTA, no es un problema

La fase anterior no pudo verificarla desde fuera. Desde dentro se ve que Apache
**no** lista `application/json` en su `AddOutputFilterByType DEFLATE`, lo que
parece un hallazgo — y no lo es: el backend comprime por su cuenta con
`compression()` (`src/main.ts:40`), así que la respuesta llega comprimida al
proxy y Apache solo la pasa. La cabecera `vary: Accept-Encoding` de `/health` lo
confirma. Añadir json al filtro de Apache no ahorraría nada y arriesgaría doble
compresión.

### HALLAZGO · `KeepAliveTimeout 5` obliga a rehacer el handshake en cada refresco

Es el hallazgo con más recorrido de toda la fase, y solo se ve midiendo con una
conexión persistente de verdad (no con `curl` suelto, que abre una por proceso).

Una conexión ociosa al API muere entre los 4 y los 6 segundos:

```
gap  2 s -> 2ª petición  672 ms   conexión viva
gap  4 s -> 2ª petición  202 ms   conexión viva
gap  6 s -> RemoteDisconnected    el servidor la cerró
gap 10 s -> RemoteDisconnected
gap 20 s -> RemoteDisconnected
gap 65 s -> RemoteDisconnected
```

Coincide exactamente con `KeepAliveTimeout 5` de `/etc/apache2/apache2.conf`.

Lo que eso significa en la clínica: la campana refresca `/actividades/resumen`
**cada 60 s**, así que la conexión está siempre muerta cuando toca el siguiente
refresco. **Cada refresco paga el handshake entero**: 610 ms en vez de 204 ms.
Y lo mismo cualquier interacción que venga después de más de 5 s de pausa, que
en un CRM son casi todas — leer un mensaje y escribir la respuesta pasa de cinco
segundos sin esfuerzo.

Comparado con el `preconnect`, que ayuda una vez por arranque en frío, esto
afecta a **todas** las peticiones que siguen a una pausa, todo el día y por cada
agente.

**Por qué subirlo es barato aquí**, comprobado y no supuesto:

- El MPM es **event**, que para esto es la diferencia entre caro y gratis: las
  conexiones ociosas las sostiene un hilo de eventos dedicado y **no ocupan un
  worker**. Con el MPM prefork la conversación sería otra.
- Carga real ahora mismo: **1 conexión TLS establecida**, 4 procesos `apache2`,
  7,1 GB de RAM libres. No hay presión de ningún tipo.

**Propuesta, sin aplicar:** subir `KeepAliveTimeout` a 65 s (justo por encima
del refresco de 60 s). Se mide con el mismo script de arriba: los gaps de 10, 20
y 65 s tienen que devolver «conexión viva» y ~204 ms en vez de fallar.

No se toca aquí porque es configuración de infraestructura en producción y la
decisión es del dueño del producto, no de la medición.

### Pista asociada, sin verificar: `SSLSessionTickets off`

`/etc/apache2/mods-enabled/ssl.conf` tiene los tickets de sesión TLS
desactivados y solo caché de servidor (`shmcb`, 300 s). Con tickets, un cliente
que vuelve reanuda la sesión y se ahorra un RTT del handshake. **No se ha
medido**, y desactivarlos suele ser una decisión deliberada de seguridad
(forward secrecy), así que aquí solo queda anotado: hace falta medir el
handshake con y sin reanudación antes de proponer nada.

### Estado del paso 2 del plan

**Hecho.** `preconnect` al origen del API implementado y el muerto de
`fonts.googleapis.com` retirado, con las dos mediciones en el cuerpo del commit
(`9ce5b24`, frontend). Sin desplegar.

---

## 18/09/2026 (mediodía) · los dos cambios aplicados y medidos

### 1. `preconnect` al API — DESPLEGADO (`9ce5b24`, frontend)

En producción: Vercel sirve `sha:"9ce5b24"`, el `<head>` declara
`preconnect` a `fonts.gstatic.com` y al origen del API, **cero menciones** de
`fonts.googleapis.com`, y los 15 `unicode-range` siguen inlineados con la woff2
bajando bien de gstatic (200, 39.412 B).

**No basta con comprobar que la etiqueta existe**, así que se midió el
comportamiento simulando las dos planificaciones con conexiones reales: bundle
bajado por una sola conexión HTTP/2 con peticiones concurrentes —como el
navegador— y el cronómetro parando en la respuesta de `/auth/perfil`.

| Planificación | p50 |
| --- | ---: |
| SERIE — bundle y *después* abrir la conexión (sin preconnect) | 912 ms |
| PARALELO — conexión abierta a la vez que baja el bundle (con preconnect) | **606 ms** |
| **Diferencia** | **306 ms (34 %)** |

Es una simulación de la planificación, no una observación del navegador: la
regla del proyecto prohíbe usarlo. Pero la red es real y el delta es el
handshake escondiéndose, que es exactamente lo que cambia el preconnect.

Un intento anterior daba 456 ms y **sobreestimaba**: bajaba el bundle en serie
por HTTP/1.1, con lo que la ventana era tan larga que escondía el handshake
entero. Vale la pena anotarlo: el número que se publica depende de si el
simulador multiplexa como el navegador o no.

### 2. `KeepAliveTimeout 5 → 75` — APLICADO

| | |
| --- | --- |
| Archivo real modificado | `/etc/apache2/sites-available/crm_backend-le-ssl.conf` |
| Config anterior | `KeepAliveTimeout 5`, **global**, en `apache2.conf:111` |
| Config nueva | `KeepAliveTimeout 75`, **acotada al VirtualHost del CRM** |
| El global | **NO se tocó**, sigue en 5 |
| Copia de seguridad | `/root/apache-backup/*.20260918-100011` |
| Aplicación | `apachectl configtest` → `Syntax OK`, luego `systemctl reload apache2` (sin restart) |

Se acotó al vhost como se pidió. Conviene saber que en esta máquina **los únicos
sitios habilitados son los del CRM**, así que no había nada más que proteger; la
elección es por higiene, no por necesidad.

**Medición sobre LA MISMA conexión persistente, y en los dos protocolos:**

| gap | HTTP/1.1 | HTTP/2 |
| ---: | --- | --- |
| 2 s | viva · 204 ms | viva · 211 ms |
| 10 s | viva · 202 ms | viva · 205 ms |
| 30 s | viva · 207 ms | — |
| **60 s** | **viva · 205 ms** | **viva · 197 ms** |
| 70 s | viva · 200 ms | viva · 201 ms |
| 80 s | **cerrada** | **reabierta · 622 ms** |

El corte cae entre 70 y 80 s, como corresponde a 75. **El caso que importa —el
refresco de 60 s de la campana— reutiliza la conexión en los dos protocolos.**

Antes / después, en el gap de 60 s:

```
ANTES (KeepAliveTimeout 5)   conexión cerrada -> TCP+TLS nuevos -> TTFB ~610 ms
DESPUÉS (75)                 conexión reutilizada            -> TTFB  ~197 ms
```

**Trampa de medición que casi produce un falso negativo.** La primera pasada de
HTTP/2 daba «reabierta» a partir de 10 s y parecía que el cambio no servía para
el protocolo que usa el navegador. No era el servidor: **`httpx` cierra sus
conexiones ociosas a los 5 s** (`Limits.keepalive_expiry = 5.0`). Con
`keepalive_expiry=600` el h2 se comporta igual que el h1. Quien repita esta
medición tiene que fijar ese parámetro o medirá su propio cliente.

**Protocolo negociado:** el API sirve **HTTP/2** por defecto (`%{http_version}`
= 2, `Protocols h2 http/1.1`), que es lo que usa el frontend. Los resultados de
h1 y h2 se reportan por separado a propósito.

### Recursos: sin crecimiento material

| | Antes del cambio | Inmediatamente después | Tras ~10 min de uso |
| --- | ---: | ---: | ---: |
| Conexiones TLS establecidas | 1 | 9 \* | **1** |
| Procesos `apache2` | 4 | 5 | **3** |
| RAM `apache2` | — | 88,6 MB | **52,0 MB** |
| Hilos de apache | — | 161 | 105 |
| RAM usada / disponible | 798 / 7.143 MB | 823 / 7.117 MB | **776 / 7.164 MB** |
| load (1 min) | 0,00 | 0,00 | 0,07 |

\* Las 9 incluían mis propias conexiones de prueba; al cerrarlas volvió a 1.

Sin crecimiento: la memoria acabó **por debajo** del punto de partida. Era lo
esperado con el MPM **event**, donde una conexión ociosa la sostiene un hilo de
eventos y no ocupa un worker.

**Salud tras el cambio:** 254 peticiones desde el reload con **0 × 500, 502, 503
y 504**; `apache2` y `crm_backend` activos, `NRestarts 0`; 0 ERROR en el journal
de ambos; `/health` 200, WebSocket 101, CORS 204.

### Rollback, si hiciera falta

```bash
cp /root/apache-backup/crm_backend-le-ssl.conf.20260918-100011 \
   /etc/apache2/sites-available/crm_backend-le-ssl.conf
apachectl configtest && systemctl reload apache2
```

No se ha necesitado: ningún síntoma de los que lo justificarían.

## Siguiente cuello de botella, medido

R3 **no está cerrado**. Con el coste por viaje ya conocido (204 ms en caliente,
610 ms en frío) se puede situar por fin el trabajo del servidor. Duraciones
reales del journal, tráfico de agentes de hoy:

| Endpoint | Media en servidor | n |
| --- | ---: | ---: |
| `GET /conversaciones/meta/plantillas` | **278 ms** | 4 |
| `POST /auth/login` | 194 ms | 4 |
| `GET /conversaciones` (inbox) | **89 ms** | 18 |
| `GET /kpis/resumen` | 74 ms | 12 |
| `GET /conversaciones/:id/resumen` | 53 ms | 8 |
| `POST /conversaciones/:id/mensajes` | 46 ms | 2 |
| `GET /conversaciones/:id` (detalle) | **34 ms** | 22 |
| `POST /conversaciones/:id/leido` | 32 ms | 18 |

Dos cosas que esto cambia respecto al diagnóstico anterior:

1. **`/conversaciones/meta/plantillas` a 278 ms es lo más lento del servidor**, y
   no es base de datos: es una llamada saliente a la API de Meta. Candidato claro
   a caché, porque las plantillas aprobadas cambian de mes en mes, no de minuto
   en minuto. **Sin verificar**: falta comprobar cuándo se pide y si bloquea algo.
2. **El inbox ya no es ruido.** El diagnóstico viejo hablaba de consultas de
   6-27 ms; `GET /conversaciones` va hoy por **89 ms**, o sea ~30 % de una
   petición en caliente. Sigue mandando la red, pero ya no se puede despachar
   como despreciable.

Y una tercera, del lado de la red: **abrir una conversación por primera vez paga
un preflight**. El log de una apertura real muestra `OPTIONS /:id` + `GET /:id` +
`OPTIONS /:id/leido` + `POST /:id/leido`. La respuesta trae
`access-control-max-age: 86400`, así que se cachea 24 h — pero **por URL**, y
cada conversación es una URL distinta. La refutación anterior («no es un coste
por URL y por sesión») es demasiado optimista: sí lo es la primera vez que se
abre cada chat. Un viaje extra de ~204 ms, serializado antes del GET.

**Lo que toca medir antes de proponer nada**, y en este orden:

1. El flujo `arranque → /auth/perfil → inbox` completo, contando viajes
   serializados. Hace falta una sesión iniciada: sin credenciales de aplicación
   solo se ve el 401.
2. Si `/conversaciones/meta/plantillas` está en el camino crítico o va de fondo.
3. Si el preflight por conversación se puede evitar sin tocar seguridad.

Sigue vetado, por falta de evidencia: Redis, cluster de Node, tuning de
PostgreSQL, cambio de VPS y mega-endpoints.

---

## 18/09/2026 (tarde) · investigación sin sesión · TRES HIPÓTESIS REFUTADAS

Esta ronda no implementa nada. Mide, y lo que encuentra es que **dos de los tres
candidatos que parecían prometedores ya están resueltos en el código**, y que el
tercero no está donde se pensaba.

R3.3 (baseline autenticado) y R3.4 (waterfall de apertura) siguen **pendientes**:
necesitan una cuenta de prueba que todavía no está disponible.

### Corrección al diagnóstico de CORS

Se corrige lo que decía la tabla de «Refutado» de la fase anterior, que era
demasiado optimista:

- **La caché del preflight es por URL concreta.** `/conversaciones/A` y
  `/conversaciones/B` **no** comparten entrada. Como cada conversación es una URL
  distinta, abrir un chat por primera vez paga su propio `OPTIONS`.
- **`Access-Control-Max-Age: 86400` no significa 24 h reales.** Chromium moderno
  aplica un tope interno de aproximadamente **7200 s** (2 h), así que la
  cabecera pide un día y el navegador concede dos horas. No hay que cambiar la
  cabecera; hay que dejar de contar con las 24 h.

Queda confirmado en el log que una apertura real dispara cuatro peticiones:
`OPTIONS /:id`, `GET /:id`, `OPTIONS /:id/leido`, `POST /:id/leido`.

### R3.6 · marcar leído — YA DESACOPLADO, no tocar

Las tres llamadas a `marcarLeido` salen con `void … .catch(() => {})`:

```
conversaciones.page.ts:122   aviso de socket
conversaciones.page.ts:156   sincronización con la ruta (la apertura)
composer:175                 indicador "escribiendo…"
```

**Nadie la espera.** El detalle llega por su propio `httpResource`, así que el
hilo, el compositor y los mensajes no dependen de ella. El log lo confirma: en
una apertura real el `POST /:id/leido` y el `GET /:id` salen **en el mismo
segundo**, en paralelo.

No hay nada que arreglar. Se documenta para que nadie lo "optimice" otra vez.

### R3.7 · plantillas de Meta — YA CACHEADO, candidato refutado

La caché que se iba a proponer **ya existe**:
`cachePlantillas = new CacheMemoria<PlantillaResumen[]>({ ttlMs: 3_600_000 })`,
una hora, con clave por línea y `obtenerAunqueVencido()` como respaldo si Meta
falla. Es justo el diseño que se habría pedido: TTL corto, por línea, sin servir
stale eternamente salvo ante error.

Cuándo se pide, medido en el log: **al cargar el detalle de una conversación**
—`plantillasWhatsApp` depende de `lineaSeleccionadaId`, que sale de
`detalleActual()`— y **no** al abrir el selector. Frecuencia real hoy: **4
llamadas HTTP frente a 22 aperturas**, y **3 de las 4 devolvieron 304**.

Los 278 ms solo se pagan cuando la caché de una hora vence. Nada lo espera: el
valor solo lo consume el modal de plantillas.

**Prioridad: baja.** No está en el camino crítico del inbox y ya tiene caché.

### R3.8 · el inbox de 89 ms — NO es PostgreSQL

`EXPLAIN (ANALYZE, BUFFERS)` contra producción (558 conversaciones, 4.139
mensajes, 15.838 clientes). Todo lectura:

| Consulta | Ejecución | Plan |
| --- | ---: | --- |
| Página del inbox (50 filas, orden `updatedAt`) | **0,27 ms** | Index Scan Backward `Conversacion_updatedAt_idx` |
| `count(*)` total | 0,15 ms | Seq Scan, 558 filas, 18 buffers |
| `count(*)` sin asignar | 0,24 ms | Seq Scan con filtro |
| Último mensaje por conversación (`take: 1`) | **1,16 ms** | Nested Loop + `Mensaje_conversacionId_createdAt_idx` |
| No leídos por conversación (`_count`) | **0,65 ms** | Index **Only** Scan `Mensaje_noLeidos_idx` |

**Todo el trabajo de base del inbox son menos de 5 ms**, con todos los buffers en
caché y los índices exactos que hacen falta. Los 89 ms del endpoint son ~85 ms
que **no** son SQL.

Dónde están, entonces: en Prisma y en los viajes Node↔Postgres. El proyecto usa
la estrategia de carga por defecto, o sea **una consulta por relación**, y
`SELECT_INBOX` tiene cinco (`linea`, `cliente`, `cliente.agente`, `agente`,
`mensajes`) más el `_count`. Sumando los cinco `count` de `contadoresInbox`, el
endpoint hace del orden de **diez a doce idas y vueltas** al motor, en **dos
transacciones que además van en serie** —`contadoresInbox` se espera *después*
del `$transaction` de la página, y no depende de él—.

**Conclusión, y es importante para no perder el tiempo:** añadir índices aquí no
serviría de nada. Los que hay ya resuelven todo en microsegundos. Lo que se
podría recortar son round trips de Prisma, y eso son dos cambios pequeños:
fundir las dos transacciones en una, y sustituir los cuatro `count` por una sola
consulta agregada con `FILTER`. Estimación conservadora: de 10-12 viajes a 6-7.

**No se implementa todavía**: falta medir el endpoint completo con sesión para
poder poner un antes y un después de verdad, que es lo que exige el método.

### R3.9 · login de 194 ms — anotado, sin prioridad

`auth.service.ts:3` importa **`bcryptjs`**, la implementación en JavaScript puro,
no el binding nativo. Es varias veces más lenta que `bcrypt` nativo, y eso
explica la cifra. No es un bug: es una elección de portabilidad, y comparar el
hash es trabajo deliberado.

Login ocurre un puñado de veces al día. **No compite** con algo que las agentes
hacen cientos de veces. Queda anotado y nada más.

### Ranking por impacto real

`impacto = frecuencia × ahorro × importancia UX`

| Candidato | Frecuencia | Coste | ¿Camino crítico? | Ahorro posible | Complejidad | Veredicto |
| --- | --- | ---: | --- | ---: | --- | --- |
| **Preflight al abrir conversación** | cada chat nuevo, cada ~2 h | ~204 ms | **sí**, serializado antes del GET | ~204 ms por apertura | media | **pendiente de medir (R3.4)** |
| **Inbox: round trips de Prisma** | cada carga y cada filtro | 89 ms (85 ms no-SQL) | sí | ~40-50 ms | baja | **candidato real** |
| Plantillas de Meta | 4/día, 3 de 4 en 304 | 278 ms en fallo de caché | **no** | ~0 | — | **refutado: ya cacheado** |
| Marcar leído | cada apertura | 32 ms | **no**, paralelo | 0 | — | **refutado: ya desacoplado** |
| Login (bcryptjs) | pocas/día | 194 ms | no | ~150 ms | media | descartado por frecuencia |

La hipótesis de la ronda anterior se mantiene **en parte**: los round trips
siguen primero, pero el segundo puesto no es «el inbox» en el sentido de la base
de datos —que está impecable— sino el número de viajes que Prisma hace para
armarlo. Y los puestos 3 y 4 se caen: ya estaban resueltos.

### Lo que falta para seguir

1. **Cuenta de prueba** para R3.3 (waterfall autenticado p50/p95) y R3.4
   (apertura de conversación con preflights cronometrados). Sin ella solo se ve
   el 401.
2. Con esa medición, decidir entre el preflight y los round trips del inbox, y
   hacer **uno solo**, con antes/después.

---

## 18/09/2026 (tarde-2) · perfilado del inbox · UN DEFECTO REAL Y UN HUECO SIN EXPLICAR

Se retira la afirmación «Prisma tarda 85 ms» de la sección anterior. **Era una
resta, no una medición**, y al medirla resultó falsa.

Método: se sembró `crm_test` a escala de producción (15.838 clientes, 558
conversaciones, 4.464 mensajes) y se perfiló `findAll` con
`process.hrtime.bigint()` y el log de queries de Prisma. Instrumentación
temporal, no commiteada.

### Lo que se midió, y lo que cada medición descartó

| Medición | Resultado | Qué descarta |
| --- | ---: | --- |
| `findAll` completo, local | **6,2 ms** p50 · 7,9 p95 | que el servicio sea lento |
| Consultas por petición | **13** | — |
| Suma del SQL que reporta Prisma | 6,6 ms | — |
| Overhead de Prisma (total − SQL) | **−0,4 ms** | **que Prisma tenga overhead**: no lo tiene |
| Petición HTTP completa, local | **5 ms** p50 | guards, interceptores y serialización |
| CPU 1 núcleo, Mac vs VPS | 198 vs **199 ms** | que el VPS sea más lento de CPU |
| `SELECT 1` ida y vuelta | 0,063 vs **0,397 ms** | 13 viajes = +4,3 ms, no 70 |
| `/health` (1 consulta) en Nest | 0 ms local vs **2 ms** VPS | coste base por petición: +2 ms |
| Compresión de la respuesta | +0,3 ms | `compression()` |
| Bytes servidos | 41,5 kB → 5,7 kB br (local) vs **6,9 kB** (prod) | volumen de datos |
| Distribución real en producción | min 42 · **p50 79** · p90 111 · max 186 | que sea un outlier: es consistente |

**La petición dominante en producción es la misma que se midió**: 317 llamadas
sin parámetros frente a un puñado con `busqueda`, y los usuarios activos son 3
SUPER_ADMIN y 2 AGENTE, o sea que el camino normal va sin filtro de visibilidad.

### HALLAZGO · el `take: 1` de los mensajes NO llega a SQL

Capturando el SQL exacto que emite Prisma:

```sql
SELECT … FROM "Mensaje"
WHERE "conversacionId" IN ($1 … $50)
ORDER BY "createdAt" DESC
OFFSET $51            -- ← no hay LIMIT
```

`SELECT_INBOX.mensajes` pide `orderBy: { createdAt: 'desc' }, take: 1`, pero
**el `take` no se traduce**: Prisma trae TODOS los mensajes de las 50
conversaciones, los ordena y se queda con el primero de cada una **en
JavaScript**.

Medido en producción: las 50 conversaciones más recientes acumulan **328
mensajes** (media 6,6 · máx 45) y el plan es un **Seq Scan de los 4.139
mensajes** de la tabla, 2,66 ms.

Hoy cuesta poco. **Crece con la tabla entera, no con la página**: es un Seq Scan
que hoy son 4.139 filas y en un año serán decenas de miles, para pintar 50.
Es deuda real aunque no sea el cuello de hoy.

### El hueco que NO se pudo explicar

Sumando todo lo medido arriba, un `GET /conversaciones` en producción debería
costar del orden de **10-15 ms**. El logger de Nest reporta **79 ms de mediana**,
de forma consistente.

**No se logró demostrar dónde viven esos ~60 ms restantes.** Se refutaron, una
por una, todas las hipótesis comprobables desde fuera: SQL, overhead de Prisma,
capa HTTP, CPU, número de viajes, compresión, tamaño de respuesta, sesgo de
datos y rol del usuario.

Se deja escrito como hueco abierto, no como conclusión. **Lo único que queda por
probar es instrumentar el propio proceso de producción** —marcas de fase dentro
de `findAll`, temporales y sin datos de pacientes—, porque ya no hay nada más
que inferir desde fuera. Requiere desplegar código instrumentado y por eso no se
hizo en esta ronda.

Mientras ese hueco no se cierre, **no se puede proponer una optimización del
inbox**: no se sabe qué se estaría optimizando.

### Estado de los candidatos

| Candidato | Estado |
| --- | --- |
| Preflight al abrir conversación | **pendiente** — necesita la cuenta de prueba (R3.4) |
| Inbox: round trips de Prisma | **bloqueado** — el hueco de ~60 ms no está explicado |
| Inbox: `take: 1` sin `LIMIT` | **defecto confirmado**, bajo impacto hoy, crece con la tabla |
| Plantillas de Meta | refutado: ya cacheado |
| Marcar leído | refutado: ya desacoplado |
| Login | descartado por frecuencia |
