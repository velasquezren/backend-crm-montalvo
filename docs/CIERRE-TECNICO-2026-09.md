# Cierre técnico — septiembre de 2026

Estado del CRM Montalvo tras cerrar R2.2 y R3. Documento corto a propósito: lo
que hay que saber para retomar, sin historia.

Verificado contra producción el **2026-09-18**.

## Arquitectura actual

```
Angular 21 (PWA, Vercel)  ──HTTPS/2──▶  Apache 2.4 · MPM event
                                         crm.107.175.132.15.nip.io
                                              │ proxy
                                              ▼
                                   NestJS 10 (127.0.0.1:3001)
                                              │ Prisma 7
                                              ▼
                                   PostgreSQL 16.14 (localhost:5432)
```

Es deliberadamente simple y **se queda así**. Sin Redis, sin cluster, sin
microservicios, sin CQRS, sin NgRx. A esta escala no resuelven un problema que
exista: lo comprobado abajo dice que no hay cuello de CPU, de memoria ni de base.

## Producción

| | |
| --- | --- |
| Servidor | Debian 12 · 4 vCPU (Xeon E5-2697 v2) · 7,8 GB RAM · 59 GB disco (22 %) |
| Backend | `crm_backend.service` · `MemoryMax=1500M` · usuario `crmapp` · `/opt/crm-backend` |
| Frontend | Vercel · PWA con Angular Service Worker |
| TLS | Let's Encrypt, renovación automática (vence 2026-12-16) |

Medido el 18/09: load **0,00**, Node al **1 % de CPU** y 280 MB, Apache 55 MB,
**7,1 GB de RAM libres**, Postgres con **99,96 % de cache hit**, **0 × 5xx** y
**0 errores** en el journal del día.

Escala real: 558 conversaciones, 4.139 mensajes, 15.838 pacientes, 5 usuarios.

## R2.2 — envío de mensajes, cerrado

Lo que **no hay que romper**, en una línea cada uno:

- **`clientMessageId`** — UUID por intención de envío, con **índice único de
  PostgreSQL**. Es la garantía, no el código.
- **Idempotencia** — el duplicado devuelve la fila existente **antes** de emitir
  socket y **antes** de despachar a Meta. Una intención, un WhatsApp.
- **Aislamiento entre conversaciones** — una clave de otro chat responde 409 y
  no filtra nada del original.
- **Retry seguro** — `ERROR` y `AMBIGUO` se reintentan con la misma clave; un
  globo sin clave no ofrece el botón.
- **Media** — el reintento reutiliza `mediaKey` y **no vuelve a subir** nada.
- **Media histórica protegida** — borrar de Mi Memoria un archivo ya enviado
  responde 409 en vez de romper el historial de la paciente.
- **PWA rollout** — indicador permanente de versión nueva, chequeo al volver el
  foco y sello de build en `window.crmBuild`.
- **Fix del bucle 401**, **R1 apertura inmediata** y el **realtime** actual.

## Rendimiento (R3)

### Mejoras conservadas

| Cambio | Antes | Después |
| --- | ---: | ---: |
| `preconnect` al origen del API | 912 ms | **606 ms** (−306 ms, −34 %) |
| `KeepAliveTimeout 75` en el vhost | ~610 ms | **~197-205 ms** tras 60 s de pausa |

La primera solapa el handshake con la descarga del bundle; la segunda evita que
el refresco de 60 s de la campana rehaga TCP+TLS cada vez. **No revertir ninguna
sin evidencia de regresión.**

### Lo que se midió y se descartó

Nada de esto es cuello, y está comprobado:

- **PostgreSQL**: todo el SQL del inbox suma **menos de 5 ms** con los índices
  actuales. Añadir índices no serviría.
- **CPU, memoria, event loop, pool de conexiones**: sin presión.
- **Plantillas de Meta**: ya tienen caché de 1 h por línea con respaldo stale.
- **Marcar leído**: ya va desacoplado con `void … .catch()`.
- **Login (194 ms)**: es `bcryptjs`, ocurre pocas veces al día.

El coste de `GET /conversaciones` vive en materializar filas en objetos, y pesa
porque **este Xeon de 2013 es ~11× más lento que una máquina moderna en
asignación y GC** (142 ms contra 13 ms; en cómputo de enteros van parejos, por
eso un benchmark de CPU engaña). Consecuencia práctica: **traer menos filas vale
más acá que optimizar consultas.**

## Tests

| | |
| --- | --- |
| Frontend | **340/340**, 32 suites, **exit 0**, cero unhandled errors, `isolate: true` |
| Backend | **559** unitarias (39 suites) · **494** integraciones (29 suites) contra PostgreSQL real |
| Compuertas | `check:tipos`, `check:skills`, `build`, `test:build` (9/9), `git diff --check` |

Deterministas: 6 campañas seguidas en el frontend y 3 en la integración del
backend, todas idénticas.

## Deuda técnica real

Cinco, todas comprobadas. No hay más.

1. **`take: 1` no limita por conversación.** Prisma emite el `IN` de 50
   conversaciones con `ORDER BY` pero **sin `LIMIT`**, trae los ~328 mensajes de
   esas conversaciones con un Seq Scan de la tabla entera y elige el último en
   JavaScript. Hoy 2,66 ms. **Crece con la tabla, no con la página** — y en esta
   máquina cada objeto de más cuesta 11 veces. Revisar cuando `Mensaje` crezca
   materialmente.
2. **Preflight por conversación.** Abrir un chat dispara `OPTIONS /:id` +
   `GET /:id` + `OPTIONS /:id/leido` + `POST /:id/leido`. La caché del preflight
   es **por URL**, y `Max-Age: 86400` no son 24 h reales: Chromium topa en
   ~7200 s. Falta el waterfall real de navegador para saber si el impacto se
   percibe. **No rediseñar el contrato de la API solo para ahorrar un OPTIONS.**
3. **MIME de la media saliente por extensión.** El despachador decide `image` vs
   `document` con `/\.pdf$/` sobre la `mediaKey`, no con `mediaMime`. Un `.docx`
   insertado desde Mi Memoria saldría como imagen y Meta lo rechazaría.
   Alcanzable en código, **cero casos en producción** (249/249 medias son
   `image/*`). Arreglo: una línea, cuando haya evidencia.
4. **`x-force-reload` es una palanca muerta.** `token.interceptor.ts` recarga la
   PWA si una respuesta trae esa cabecera; **el backend no la emite nunca**.
   Sirve para forzar actualización ante un breaking change, pero hoy nadie la
   dispara.
5. **La PWA no se auto-recarga.** Hay indicador permanente y chequeo al volver
   el foco, pero adoptar la versión nueva exige una navegación. Una agente que
   no recarga sigue con código viejo — costó dos diagnósticos el 17/09. No se
   automatizó porque no se puede distinguir un momento seguro (borrador, adjunto
   preparado, upload en curso, globo `ENVIANDO`).

## Escalabilidad

Horizonte real: **decenas de agentes, cientos de miles de mensajes**. Para eso:

- **Lo que aguanta sin tocar nada**: la base (índices correctos, 99,96 % de
  cache hit), la máquina (7 GB libres, load 0), el pool de Prisma (10, con 2 en
  uso) y el modelo de paginación del inbox.
- **Lo que hay que vigilar, en este orden**: el punto 1 de la deuda —es el único
  que empeora con el volumen— y después el número de filas que materializa cada
  endpoint, por la característica de esta máquina.
- **Lo que NO hace falta**: Redis, cluster de Node, CDN delante del API, sharding
  ni cambiar de VPS. Nada de eso resuelve un problema que exista hoy.

La señal para reabrir esto no es una fecha: es que `GET /conversaciones` suba de
forma sostenida por encima de ~150 ms de servidor, o que `Mensaje` pase de unas
decenas de miles de filas.

## Próximo trabajo recomendado

Producto, no infraestructura. Lo técnico está cerrado.

1. Decidir sobre **CAMP-0** (campañas de Meta y ROI): el diagnóstico está hecho
   en `docs/CAMP-0-campanas-meta-roi.md`, falta decidir si se construye.
2. Si alguna vez se quiere cerrar el punto 2 de la deuda, hace falta **una cuenta
   de prueba** para medir el waterfall autenticado real.
3. Agenda A6/A7 y lo demás del backlog de producto.
