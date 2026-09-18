# Estado actual

## 18 de septiembre de 2026 (cierre) · CONSOLIDACIÓN TÉCNICA CERRADA

**Empieza por aquí:** [`docs/CIERRE-TECNICO-2026-09.md`](CIERRE-TECNICO-2026-09.md).
Resume arquitectura, producción, R2.2, rendimiento, tests, deuda real (5 puntos)
y escalabilidad. Todo lo que hay debajo de esta sección es historia.

| | Backend | Frontend |
| --- | --- | --- |
| `main` = `origin/main` | `ee57d3a` + esta consolidación | `9ce5b24` + esta consolidación |
| Desplegado en producción | `ee57d3a` | `9ce5b24` (Vercel) |
| Servidor | **Debian 12 · 4 vCPU · 7,8 GB · `107.175.132.15`** | Vercel |

Migraciones: todas aplicadas; la última es
`20260917200000_mensaje_client_message_id` (el índice único de R2.1). **No hay
migraciones pendientes de desplegar.**

**R2.2 cerrado y en producción**: `clientMessageId` con índice único,
idempotencia real, aislamiento entre conversaciones, reintento seguro con y sin
adjunto, media histórica protegida con 409.

**R3 cerrado** con dos mejoras vivas —`preconnect` al API (−306 ms en arranque
frío) y `KeepAliveTimeout 75` en el vhost (610 → ~200 ms tras una pausa)— y el
resto descartado con medición: ni CPU, ni memoria, ni PostgreSQL, ni event loop,
ni pool son cuello.

**Agenda A1-A5** sigue como estaba; no se tocó en esta ronda. **CAMP-0** queda
como investigación en `docs/CAMP-0-campanas-meta-roi.md`, sin implementar.

Documentación corregida en esta consolidación, porque contradecía producción:
el skill de infraestructura describía el VPS viejo de 1 núcleo en
`107.172.193.34`; `crm-backend-module` afirmaba que `meta.target` dice qué
columna chocó —falso con el driver adapter, y es lo que tuvo rota la
idempotencia—; `crm-conversaciones` documentaba el rollback de envío anterior a
R2; y `META_INTEGRATION_GUIDE.md` listaba cinco variables de entorno que no
existen en el código.

**Rama huérfana, sin tocar:** `origin/wip/2026-08-24-unidad-negocio-ventana24h`
(2 commits del 24/08, tipo stash, sobre Planilla y el compositor). No está
integrada y **no se borró**. Decidir si se recupera o se descarta.

## 18 de septiembre de 2026 (mañana) · huecos cerrados — TODO DESPLEGADO

Cierra los dos pendientes que dejó la sesión anterior. **Ya no queda nada a
medias entre repositorio y producción.**

| | Backend | Frontend |
| --- | --- | --- |
| `main` = `origin/main` | **`af13075`** | **`7aac8af`** |
| Desplegado en producción | **`af13075`** (18/09 09:27 EDT) | **`7aac8af`** (Vercel, 13:28 UTC) |

### 1. `1692069` desplegado

Era el hueco real: el aislamiento de `clientMessageId` entre conversaciones
estaba en `origin/main` desde la noche anterior y **no en el servidor**. La
sesión previa no pudo desplegarlo porque esa máquina no tiene clave autorizada
en el VPS; desde esta sí.

Reinicio controlado de ~4 s (arranque 09:27:51, Nest listo 09:27:55).

```
HEAD af13075 · servicio active · NRestarts 0 · 24 módulos · health 200 en 0,30 s
smoke: login vacío 400 · periodos 401 · conversaciones 401 · memoria-agente 401
       WebSocket HTTP/1.1 101 · CORS preflight 204 con allow-origin correcto
logs:  0 ERROR · 0 P2002 · 0 «reutilizado entre conversaciones» · 0 × 500
       único 503: la ventana del reinicio, reconectó solo
```

Validado antes de subir: 494/494 integraciones (29 suites), 559/559 unitarias
(39 suites), build con `check:skills` y `check:build`.

### 2. `npm test` del frontend ya sale con 0

Estaba documentado como deuda y hacía que la suite nunca terminara limpia:
decía «340 passed» y devolvía **exit 1** por dos rechazos no manejados NG04002.
El interceptor navega a `/auth/login` al desloguear y `bucle-401.spec.ts` se
montaba con `provideRouter([])`, así que esa navegación rechazaba fuera del
ciclo del test. Los casos pasaban —el rechazo llega después— pero Vitest lo
contaba como error del run.

Arreglado en **`7aac8af`** declarando la ruta, sin componente: lo que la prueba
comprueba es que se navega, no qué se pinta. **8 campañas consecutivas: exit 0,
32 suites, 340/340, cero errores no manejados.**

Con esto desaparece de la lista de deuda de test la entrada de los dos
NG04002; las otras dos (base de integración a recrear tras una tanda abortada,
y no vaciar tablas compartidas en los specs) siguen vigentes.

### Verificado de forma independiente

- Vercel sirve `sha:"7aac8af"` y el chunk de Conversaciones contiene
  «Subiendo archivo…»: **R2.2 está vivo en producción**, no solo publicado.
- El artefacto del servidor contiene el 409 y el aviso del journal del fix de
  aislamiento, comprobado en `dist/` antes de reiniciar.

### Qué sigue abierto

Nada operativo. Dos decisiones de producto, ninguna empezada:

1. **CAMP-0** — diagnóstico terminado en `docs/CAMP-0-campanas-meta-roi.md`.
   Falta decidir si se construye el módulo.
2. **R3** — detenido en diagnóstico a propósito
   (`docs/rendimiento-r3-2026-09.md`). Sin implementar nada.

## 18 de septiembre de 2026 · cierre de R2.2 publicado + CAMP-0 diagnóstico

Esta sección reemplaza el estado de la entrega que figura inmediatamente debajo.
Referencias remotas consultadas con `git fetch` en ambos repositorios.

| Repositorio | Estado comprobado |
| --- | --- |
| Backend | `main` = `origin/main` = `1692069` |
| Frontend | `main` = `origin/main` = `9e53164` |
| R2.2 | Publicada en `origin/main`; Vercel queda encargado del despliegue automático |
| CAMP-0 | Diagnóstico terminado en [`docs/CAMP-0-campanas-meta-roi.md`](CAMP-0-campanas-meta-roi.md) |
| R3 | **Detenido en diagnóstico**, sin implementar nada: [`docs/rendimiento-r3-2026-09.md`](rendimiento-r3-2026-09.md) |

**Producción, comprobada por HTTP el 18/09/2026 04:36 UTC** (no por SSH: el VPS
nuevo solo acepta clave pública y esta máquina no está autorizada).

| | Comprobación | Resultado |
| --- | --- | --- |
| Frontend | sello de build servido por Vercel | **`9e53164`**, compilado 2026-09-18T01:52:33Z — R2.2 **está en producción** |
| Backend | `/health` | 200, `baseDatos: ok`, uptime 7 h 44 min |
| Backend | login vacío → 400 · periodos sin token → 401 | ValidationPipe y guard vivos |

**El backend NO se ha redesplegado:** ese uptime sitúa el arranque en el mismo
despliegue de `5e8bbf0` del 17/09 a las 16:52 EDT. Por tanto **`1692069` sigue sin
desplegar** — el aislamiento de `clientMessageId` entre conversaciones está en
`origin/main` y no en el servidor.

El orden obligatorio (backend → frontend) se rompió en esta entrega: el frontend
salió primero. **No causa daño aquí** y conviene dejar escrito por qué, para que
nadie lo tome como precedente: lo que R2.2 del frontend necesita del backend es
`clientMessageId` y la traducción del choque del índice único, y las dos cosas ya
estaban desplegadas en `5e8bbf0`. Lo único que falta en producción, `1692069`, es
endurecimiento para un caso que el frontend no produce (reutilizar la misma clave
en otra conversación). Sigue pendiente desplegarlo.

El bloqueo de pruebas **ya está resuelto** en `abbfe59`. El runner de Angular
compartía el registro de módulos entre specs (`isolate: false`), permitiendo que
RealtimeService conservara el socket real cuando otro spec lo importaba antes
del mock. `vitest-base.config.ts` habilita `isolate: true`. El commit documenta
12 campañas consecutivas con 340/340 pruebas aprobadas. No queda pendiente
reinvestigar los specs de adjuntos ni volver a integrar la rama.

La entrega incluye el reintento del adjunto conservando su `mediaKey` y su
`clientMessageId` (`ab81d8f`), el aviso de subida en curso (`5708fc0`) y el
aislamiento del arnés (`abbfe59`). El backend incorpora además `1692069`:
rechaza con 409 una clave de idempotencia perteneciente a otra conversación,
sin devolver su mensaje ni despachar otro envío.

### Validación de este cierre

- `npm run build`: exit 0; `check:tipos` y `check:skills` correctos.
  Bundle inicial: 408,08 kB / transferencia estimada 107,68 kB.
- `npm test -- --watch=false`: 32 suites y 340 aserciones de prueba aprobadas,
  pero **exit 1** por los dos rechazos no manejados NG04002 de
  `bucle-401.spec.ts` ya documentados debajo. No equivale a una suite limpia.
  No reapareció el fallo de Realtime en esta corrida.
- Permanece el aviso NG8113 por `DrawerComponent` sin usar en Actividades.
- Evidencia local: `/tmp/crm-r22-cierre-tests.log` y
  `/tmp/crm-r22-cierre-build.log`; son archivos temporales, no versionados.
- Esta revisión solo actualiza esta nota. No publica commits ni despliega.

**Siguiente paso operativo:** revisar el informe CAMP-0 antes de decidir si se
construye el módulo. R3 no se ha iniciado.

## 17 de septiembre de 2026 · R2.1 real, PWA rollout y R2.2 — BACKEND DESPLEGADO, FRONTEND DETENIDO

Día largo. Lo que importa para retomar está en las dos primeras tablas; el resto
explica el porqué para no repetir investigaciones ya hechas.

### Dónde está cada cosa AHORA

| | Backend | Frontend |
| --- | --- | --- |
| `main` = `origin/main` | **`5e8bbf0`** | **`aff2f73`** |
| Desplegado en producción | **`5e8bbf0`** (16:52 EDT) | **`aff2f73`** (Vercel) |
| Rama pendiente de integrar | — | **`feat/r2-2-media-segura`** = `5708fc0` |

Backend y frontend están **alineados con su producción**. Lo único fuera es la
rama de R2.2 del frontend, y está detenida a propósito (ver más abajo).

### Lo que sí quedó desplegado hoy

| Entrega | Commit | Estado |
| --- | --- | --- |
| R1 · apertura inmediata de conversación | `7773696` | frontend, desplegado |
| R2 · envío optimista seguro (ENVIANDO/ERROR/AMBIGUO) | `c132345` | frontend, desplegado |
| R2.1 · `clientMessageId` + UNIQUE en PostgreSQL | `a17a700` | backend, desplegado |
| Fix del bucle 401 → logout → recarga | `f3d03de` | frontend, desplegado |
| PWA rollout visible + sello de build | `5687572`, `aff2f73` | frontend, desplegado |
| R2.1 **de verdad** + media histórica protegida | `5e8bbf0` | backend, desplegado |

### R2.1 estaba roto en producción, y nadie lo sabía

`recuperarEnvioDuplicado` identificaba el índice que rebotaba leyendo
`error.meta.target`. **Con el driver adapter de Prisma 7 ese campo no existe**:
el nombre real viaja en `meta.driverAdapterError.cause.constraint.index`. Así
que el método no reconocía el choque de `clientMessageId`, devolvía `null`, y el
P2002 subía tal cual — la agente recibía un **500 sobre un mensaje que SÍ se
había enviado**, y el reintento que R2.1 existía para hacer seguro era justo el
que no funcionaba.

No se vio antes porque **nada lo ejercitaba**: la suite de R2.1
(`idempotencia-envio.integracion.spec.ts`) comprueba el índice único contra
Prisma directamente y **nunca pasa por el service** — cero referencias a
`enviarMensaje`. Y producción no lo delataba: el único envío con clave que había
entrado no se reintentó ni una vez.

Corregido en `71777ef` con `choqueDe()`, que mira las dos formas. **El patrón
correcto ya existía en el repo** (`transaccion-periodo.js` usa
`driverAdapterError`); Conversaciones se lo había perdido. La cobertura nueva va
contra el SERVICE y contra Postgres real:
`src/modules/conversaciones/idempotencia-media.integracion.spec.ts`.

**Lección, para no repetirla:** probar el índice único NO es probar la
idempotencia. La garantía es de PostgreSQL, pero traducir su rebote es código
nuestro y necesita su propia prueba, a través del service.

### Media histórica protegida

`memoria-agente.remove()` borraba de R2 sin mirar si un `Mensaje` referenciaba
esa `mediaKey`. Como ese endpoint sube tanto la biblioteca como los adjuntos del
chat, limpiar Mi Memoria rompía imágenes en el historial de pacientes, de forma
permanente. Ahora responde **409** y rechaza la operación entera (`fbc5de6`).
Sin schema, sin índice, sin GC.

### R2.2 frontend — TERMINADO EN RAMA, DETENIDO POR UNA SUITE INESTABLE

La rama `feat/r2-2-media-segura` (`ab81d8f` retry de adjunto sin reupload;
`5708fc0` estado visible de subida) **está completa y pasa todas las compuertas**
— 340/340, check:tipos, check:skills, build, bundle dentro de presupuesto.

**Por qué NO se integró:** al validar antes del merge se midió que los dos
ficheros de prueba nuevos desestabilizan una suite ajena,
`src/app/core/realtime/realtime.service.spec.ts`, que falla sus 7 tests **en
bloque** aproximadamente **1 de cada 10 corridas**.

| Medición | Resultado |
| --- | --- |
| `main` (`aff2f73`), 8 campañas | 323/323 siempre |
| Rama completa | 1 fallo / 6 · 1 fallo / 15 |
| Rama **sin** los 2 specs nuevos, **mismo código productivo**, 8 campañas | **8/8 verde** |
| `realtime.service.spec.ts` en aislamiento, 6 campañas | 9/9 siempre |
| `realtime` + los 2 specs nuevos juntos, 8 campañas | 26/26 siempre |
| Suite completa con **solo** `reintento-media.spec.ts`, 10 campañas | 1 fallo / 10 |

**El código productivo está limpio**: lo prueba la tercera fila. Es
contaminación entre ficheros de test, y el culpable reproducible es
`reintento-media.spec.ts`.

Síntoma exacto: `fabrica.io.mock.calls[0]` es `undefined` — el socket falso
nunca llega a crearse, o sea que `RealtimeService.abrirSocket()` no corre.

**Dos hipótesis ya investigadas y DESCARTADAS con medición. No repetirlas:**

1. `Element.prototype.scrollIntoView = vi.fn()` sin restaurar. Se adoptó el
   patrón defensivo de `detalle-fallido.spec.ts` (`if (!…) … = () => {}`) y
   **siguió fallando 1/15**. El parche se revirtió para dejar la rama en los SHA
   aprobados; aun así, ese patrón defensivo es el correcto si se vuelve a tocar.
2. Fuga del `RealtimeService` entre suites. **Ni el thread ni el composer lo
   inyectan**: solo lo hacen `conversaciones.page.ts` y
   `notificaciones-bell.component.ts`, y los specs nuevos no montan ninguno.

**Pista sin explorar:** `realtime.service.spec.ts` usa `vi.hoisted()` +
`vi.mock('socket.io-client')`. Si otro fichero del mismo worker carga el módulo
real antes, el mock no aplicaría y `RealtimeService` quedaría con el `io` de
verdad — encaja con el síntoma. Verificarlo antes de tocar nada.

**Riesgo de dejarlo esperando: ninguno.** El frontend en producción no tiene el
botón de reintento de media, así que el defecto de R2.1 que hoy se corrigió no
es alcanzable desde la interfaz. Y el orden obligatorio ya se cumplió: el
backend fue primero, así que cuando el frontend entre, el reintento ya está
soportado del otro lado.

### PWA: cómo saber qué build ejecuta un navegador

Un despliegue correcto **no** significa que la clínica esté ejecutando esa
versión. Hoy costó dos diagnósticos: R2.1 estaba en Vercel y el navegador seguía
mandando sin `clientMessageId`.

- `window.crmBuild` → `{ sha, compiladoEn }`, y la consola lo imprime al
  arrancar. El SHA lo incrusta `tools/generar-sello-build.mjs` desde
  `VERCEL_GIT_COMMIT_SHA` / `GITHUB_SHA` / `git`, **nunca a mano**.
- El archivo generado (`src/app/core/build/app-build.ts`) está en `.gitignore`.
  **Por eso los comandos oficiales son los de npm**: `ng build` o `ng test` a
  secas fallan en un checkout limpio con un import inexistente. Es correcto, no
  un bug.
- Hay indicador permanente de «Actualizar» en la cabecera mientras haya versión
  pendiente, y se busca actualización al volver el foco (throttle de 5 min).
  **No hay auto-reload**, a propósito: hoy no se puede distinguir un momento
  seguro (borrador, adjunto preparado, upload en curso, modal, globo ENVIANDO).

### Deuda de test conocida, NO tocar en esta ronda

- `frontend/src/app/core/auth/bucle-401.spec.ts` deja **2 «Unhandled Errors»**
  (router sin rutas, `NavigationError` 4002). Verificado idéntico en `main`: no
  es regresión. Sale también si se corre ese archivo solo.
- `npm run test:integracion` del backend **exige base limpia entre tandas si una
  suite aborta a media**: una corrida fallida deja filas y la siguiente falla en
  cascada. Ante 161 fallos raros, `npm run test:integracion:preparar` primero.
- **No vaciar tablas «por si acaso» en los specs de integración.** La línea
  `00000000-0000-4000-8000-000000000001` la **siembra una migración** y de ella
  dependen cuatro suites; un `lineaWhatsapp.deleteMany()` la borraba y todas las
  corridas siguientes fallaban con `Conversacion_lineaId_fkey`. Limpiar solo lo
  que la prueba crea, por id.

### MIME de la media saliente: latente, documentado, SIN tocar

`despachador-saliente.service.ts` decide `image` vs `document` por la
**extensión de la `mediaKey`** (`/\.pdf$/`), no por `mediaMime`. Como
`insertarRecursoEnChat()` no filtra por tipo y la whitelist acepta `.docx` y
audio, un documento de Word saldría a Meta como `type: 'image'` y rebotaría.

**Evidencia en producción: cero.** 249 medias salientes, todas `image/*`, 0
claves `.pdf`, 0 discrepancias; en Mi Memoria solo hay jpeg y png. La ruta es
alcanzable pero **nunca se ha ejercitado**, así que se dejó fuera por decisión
explícita: no hay cambio colateral sin evidencia. El arreglo, cuando se quiera,
es una línea: decidir por `mediaMime`, que ya está persistido.

### Lo siguiente

1. Resolver la contaminación entre specs e integrar `feat/r2-2-media-segura`.
   **No hace falta tocar código productivo.**
2. R3 no se ha empezado.

## Auditoría F01–F10 — CERRADA EN CÓDIGO

Revalidada finding por finding contra el código, no contra esta documentación.
Los diez quedan cerrados, con pruebas ejecutables. Ninguno abierto, parcial ni
sin clasificar.

**Tres cosas distintas, y conviene no mezclarlas nunca:**

| | Estado |
| --- | --- |
| **Auditoría** | **CERRADA** |
| **Código** | **CORREGIDO** |
| **Producción** | **PENDIENTE DE DESPLIEGUE** de casi todo lo cerrado |

### Dónde está cada cosa

| | Backend | Frontend |
| --- | --- | --- |
| Último commit corregido | `b6f61e1` | `f0acb57` |
| Rama de respaldo remota | `auditoria-f01-f10` | `auditoria-f01-f10` |
| `origin/main` | `75f8e30` | `6e16040` |
| **Desplegado en producción** | **`7194843`** (14/9) | **`6e16040`** |

**La producción del backend lleva nueve commits de retraso** e incluye **dos
migraciones de la auditoría sin aplicar**: `20260914234808_media_entrante_durable`
(F06-R1, `8faa263`) y `20260915002934_primer_contacto_durable` (F06-R2,
`b6ec462`). F06 está cerrado en código desde el 14 de septiembre y **nunca se
desplegó**. Contando también la rama de Agenda, el atraso real de producción son
**tres** migraciones: ver «Agenda / Actividades» más abajo.

Al desplegar, **el backend va primero**: el frontend pendiente depende de
contratos nuevos suyos (`limiteLista` del historial, `antesDeId` del cursor).
Y recordar que el push a `main` del frontend publica en Vercel solo con empujar.

### Entregas de esta ronda

| Entrega | Commit | Repo |
| --- | --- | --- |
| F08 · carreras en Planilla | `6e16040` | frontend — **desplegado** |
| F10 · calendario por rango visible | `cdc0f22` | frontend — local |
| F10.2 · resumen del paciente sobre todo el historial | `3fddd28` | backend — local |
| F10.2 · aviso de lista recortada | `7da0397` | frontend — local |
| F10.3 · cursor de mensajes con desempate | `b09132b` | backend — local |
| F10.3 · el cursor manda el id | `9c204bc` | frontend — local |
| F09 · contrato de la baja de suscripción | `0f278cf` | backend — local |
| F09 · envío global muerto fuera, usuario activo blindado | `b6f61e1` | backend — local |
| F09 · desuscribir el dispositivo al cerrar sesión | `f0acb57` | frontend — local |

Antes: el P0 del límite de subida (`a383f3d`, backend, local).

### Lo que la revalidación demostró FALSO

El informe maestro del 5 de septiembre tiene tres afirmaciones que el código ya
desmiente. **Manda esta sección, no aquel documento**, que es una foto fechada.

- **§10 · «`RealtimeService` captura el token al crear el socket y no lo
  actualiza en refresh».** Falso: `auth: callback => callback({ token })` lee el
  token **en cada handshake**, y `connect_error` refresca y reconecta sin bucle.
  Siete pruebas.
- **§10 · «El servidor tampoco impone expiración a sockets ya conectados».**
  Falso: `handleConnection` desconecta si el token ya expiró **y programa un
  `setTimeout` para desconectar en el instante de expirar**.
- **§18 · «El guard confía en el rol del token durante hasta 8 h».** Falso:
  `validarSesion` consulta la sesión en CADA petición y rechaza si el usuario no
  está activo, si `versionSesion` no coincide, o si el rol del token difiere del
  de la base.

Y una cuarta, del propio código: el comentario de `servicios.service.ts` fijaba
el máximo real en **20 servicios por paciente**. Contando el diciembre real de la
clínica, un paciente acumuló **31 en un solo mes** — por eso los topes de 200 y
500 eran alcanzables y hubo que tocarlos.

### F10 · calendario

`limite: 100` sin rango devolvía las cien actividades **más antiguas del
historial entero** —el backend ordena `fechaProgramada: 'asc'`—, así que el mes
visible podía salir vacío teniendo actividades. Reproducido: 151 en la base,
calendario en septiembre de 2026, llegaban 100 filas todas de 2024.

Ahora Schedule-X publica su rango por `onRangeUpdate` y la página lo usa como
clave del recurso. Contrato en `rango-calendario.ts`: instantes UTC, los dos
extremos inclusivos —igual que el `gte`/`lte` del backend—, en la zona del
navegador y ensanchados a días completos. Sin endpoint nuevo.

### F10.2 · historiales

**El comentario del código decía «hoy el máximo real son 20» y medía otra cosa.**
Contando el diciembre real de la clínica: un paciente acumuló **31 servicios en
UN SOLO MES**. A ese ritmo el tope de 200 de la ficha se cruza en unos siete
meses y el de 500 en unos diecisiete. No era un riesgo teórico.

Los dos endpoints calculaban su resumen sobre el array recortado. El campo más
engañoso era «primera visita»: la lista va en `fecha desc`, así que era la 500ª
más reciente — no incompleta, equivocada, y el cajón la imprime como «Línea de
tiempo — del X al Y».

Los topes se quedan (son defensivos); el resumen sale ahora de una consulta
agregada sobre todas las filas, y la respuesta añade `limiteLista` para que la
pantalla diga «500 de 520» en vez de afirmar que son 500.

### F10.3 · cursor de mensajes

`createdAt` **no desempata**: es `TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP` y en
PostgreSQL eso vale la hora de inicio de transacción, así que cuanto persiste la
ingesta en una misma transacción comparte el instante exacto. Está garantizado
cada vez que un webhook trae varios mensajes, no es una casualidad.

Con el `<` estricto, una página que cortara dentro del grupo empatado saltaba al
resto para siempre. Medido: recorriendo el hilo entero se veían **5 de 8**
mensajes. El cursor pasa a ser el par `(createdAt, id)`; `antesDeId` es opcional
para no romper a un cliente que solo mande la fecha.

### Validación de las tres

Backend: build con `check:skills`, **551 unitarias / 38 suites**, `test:build`
9/9, **434 integraciones / 23 suites** contra PostgreSQL 16.15 descartable
(eran 425/22), typecheck estricto con specs. Frontend: **167 / 18 suites**
(eran 142/15), typecheck y build con `check:tipos` y `check:skills`.
`git diff --check` limpio en los dos repos.

Cada corrección se comprobó rompiéndola a propósito y viendo caer su prueba por
el motivo correcto. Dos pruebas hubo que reescribirlas porque pasaban por el
motivo equivocado: la del orden entre empatados (afirmaba que dos llamadas
coinciden, cosa que Postgres cumplía por casualidad) y la del Caso A del
calendario (fallaba por el andamiaje del test, no por el corte de 100).

### Hallazgo aparte, sin tocar: `Temporal` global

`@schedule-x/calendar` usa `Temporal` como **global libre** —lo declara
`peerDependency` y no lo importa nunca en su `dist/core.js`— y **nada en esta
app instala ese global**. Hoy funciona porque el navegador lo trae nativo; en
uno que no lo traiga, la vista Calendario revienta con `ReferenceError`. Salió
al montar las pruebas del calendario. Es una línea en el arranque, pero es
compatibilidad y no F10: queda como entrega propia, sin decidir.

## Agenda / Actividades — mejora de producto, TERMINADA EN RAMA

**Esto no es auditoría.** No sale de ningún finding: es trabajo de producto
sobre el módulo de Actividades, y se lee aparte de F01–F10. Vive entero en la
rama `agenda-actividades-v2` de los dos repos.

| Fase | Qué resolvió | Estado |
| --- | --- | --- |
| **A1** · zona de la clínica | Una sola definición de «hoy», `America/La_Paz`, con gemelos en los dos runtimes | **CERRADO** |
| **A2** · completar + siguiente | «Completar y agendar siguiente paso» dejó de perder el seguimiento | **CERRADO** |
| **A3** · extracción del formulario | El formulario de crear/editar pasó a componente propio | **CERRADO** |
| **A4.1** · selector de paciente | Búsqueda, lead y alta express, con un solo dueño | **CERRADO** |
| **A4.2** · cajón de detalle | Presenta y propone; la página sigue siendo quien muta | **CERRADO** |
| **A5** · series repetitivas | Identidad de serie y dos operaciones sobre las siguientes | **CERRADO** |

### Qué es A5, en concreto

- **Identidad, no motor de recurrencias.** `serieId` (`uuid`) + `frecuenciaSerie`
  en cada ocurrencia. No se guarda el patrón ni una fecha de fin: las filas ya
  existen todas desde el alta, y son ellas las que dicen cuándo es cada una.
- **La cadencia es canónica y sale de Prisma.** `enum FrecuenciaRepeticion
  { SEMANAL QUINCENAL MENSUAL }` en `schema.prisma`; el frontend la recibe por
  `db-enums.ts` y `check:tipos` falla si divergen. **No hay frecuencia diaria**,
  y nunca la hubo en el código.
- **Cancelar esta y las siguientes** — `PATCH /actividades/:id/esta-y-siguientes/cancelar`.
- **Cambiar la hora de esta y las siguientes** — `PATCH /actividades/:id/esta-y-siguientes/hora`,
  con `{ hora: "HH:MM" }`. **Cada ocurrencia conserva su propio día de
  calendario**; solo cambia la hora de reloj de la clínica.
- **FUTURAS = misma serie, `fechaProgramada >= la de la elegida`, solo
  PENDIENTES, y dentro del alcance de quien pide.** Compartir `serieId` no da
  permiso sobre lo que es de otra agente: F04 sigue mandando.
- **No hubo backfill.** Lo agendado con «repetir» antes de A5.1 tiene
  `serieId = null` y se comporta como actividad individual, porque entonces no
  se guardaba nada que enlazara las ocurrencias. La migración es puramente
  aditiva y no reescribió ni una fila existente.
- **El máximo de 12 se conserva** tal cual estaba; A5 no tocó el alta.
- **No existe** editar la serie entera, ni mover su día, ni eliminarla:
  eliminar afecta siempre a una sola actividad. Para detener seguimientos
  futuros se cancela.
- **La interfaz solo ofrece «esta y las siguientes» para un cambio de hora
  puro** (mismo día de clínica, nada más tocado). Es deliberado: un solo
  «Guardar» no puede ser dos intenciones.

### Dónde está A5, y dónde no

| | |
| --- | --- |
| Implementado en rama `agenda-actividades-v2` | **Sí** — backend `ab04a16`, frontend `a9245c1` |
| En `main` | **No** |
| Desplegado | **No** |

**Migraciones pendientes en producción: exactamente tres.**

| Migración | Origen | ¿En `origin/main`? |
| --- | --- | --- |
| `20260914234808_media_entrante_durable` | F06-R1 | sí |
| `20260915002934_primer_contacto_durable` | F06-R2 | sí |
| `20260917013320_serie_actividades` | A5.1 | no — solo en la rama |

Contadas contra Git, no de memoria: 47 migraciones en la rama, 46 en
`origin/main`, 44 en el commit desplegado `7194843`.

**A6 (recordatorios y motivo de cancelación) y A7 (calendario interactivo) son
fases futuras de producto, no findings pendientes.** Nadie las ha empezado y
nada las bloquea.

## 16 de septiembre de 2026 · límite de subida de la planilla — COMMITEADO, SIN DESPLEGAR

**El único P0 que seguía vivo del informe maestro, arreglado** en `a383f3d`.
`FileInterceptor('archivo')` de `/planilla-comisiones/importar` iba sin `limits`:
el tope de 15 MB se comprobaba con el archivo ya entero en memoria. Ahora multer
corta en 20 MB —por encima del tope de negocio a propósito, para que quien se
pasa poco siga leyendo «pesa 16,2 MB; el máximo es 15 MB» en vez de un 413
pelado—. Ventas y Memoria ya cortaban en transporte; este era el último.

**Matiz que corrige al informe maestro.** §8 lo lista P0 sin decir por dónde se
entra. En Nest los guards corren ANTES que los interceptores, así que multer no
lee un byte hasta que `JwtAuthGuard` y `RolesGuard` autorizan: **no es alcanzable
sin un token SUPER_ADMIN válido**. El riesgo comprobado es **agotamiento de
memoria por un upload administrativo demasiado grande** —VPS de un núcleo con
`MemoryMax=400M`, compartido con el webhook de WhatsApp—, no exposición anónima.
Sigue mereciendo el arreglo: ese es justamente el caso probable.

Cuatro pruebas nuevas (`limite-upload-planilla.spec.ts`) con Nest HTTP real y
multipart de verdad, sin PostgreSQL. Comprobadas revirtiendo el interceptor: los
25 MB volvían a responder 400 con «pesa 25,0 MB», que es la firma de haberlo
leído entero. Esa comprobación desmintió de paso dos cosas, y quedaron escritas
en el spec: `files: 1` **no** es lo que rechaza una segunda parte —eso ya lo
hacía `.single()`— y un `Buffer` no vale como `BodyInit` de `fetch` bajo
TypeScript 5.9 aunque en ejecución funcione.

**Sin desplegar. Sin tocar frontend.**

### La integración pendiente desde el 10 de septiembre: SALDADA

El handoff de Finanzas dejó escrito que había que correr `test:integracion`
completo contra PostgreSQL descartable antes de desplegar aquello, y que no se
había hecho porque esta máquina no tenía base en el 5433. **Se hizo el 16 de
septiembre aquí**: PostgreSQL 16.15 descartable con la receta de
[crm-backend-arquitectura §8](../.claude/skills/crm-backend-arquitectura/SKILL.md),
**las 44 migraciones aplicadas limpias desde cero** y **425 casos / 22 suites en
verde**, antes y después del cambio de este día. El servidor se detuvo y se
borró al terminar. `verificacion-diciembre` conserva su limitación: sale PASS
avisando por consola que sus asserts NO se ejecutaron.

Compuertas de este día: `npm run build` con `check:skills` y `check:build`,
**551 unitarias / 38 suites** (eran 547/37), `test:build` **9/9**, typecheck
estricto de `src/**/*.ts` con specs incluidos, y `git diff --check` limpio.
Frontend sin cambios: build verde y 142 pruebas / 15 suites.

### Deriva documental corregida

Cinco cosas que este archivo o el informe maestro daban por abiertas y se
comprobaron **cerradas en el código**:

- **F08, mitad inbox: hecha.** `cargarMas` y `refrescarFilaPorRealtime` ya
  descartan con `filtros !== this.filtros()`. F08 queda reducido a Planilla.
- **Último superadministrador: ya es atómico.** `usuarios.service.ts` toma
  `pg_advisory_xact_lock(730013)` dentro de la transacción. El §9 del informe
  maestro lo sigue listando como carrera abierta.
- **Caché de detalles del chat: eliminada.** Era el candidato nº 1 de
  simplificación del §17.
- **Push a usuario desactivado:** la ruta real —`LineasWhatsappService.destinatarios`—
  filtra `activo: true` y aplica alcance. Lo que queda abierto del §12 es otra
  cosa, el logout; ver los pendientes de abajo.
- **`reintento-saliente.service.spec.ts`** ya no importa `Logger` sin usarlo.

### Pendientes reales, comprobados en el código el 16/9

Solo lo que se verificó abierto leyendo el código de hoy. Lo que no aparece
aquí, o está cerrado o no se pudo comprobar desde esta máquina.

Los cuatro de F08 y F10 que encabezaban esta lista están corregidos: ver la
sección de cierre al principio del archivo. Lo que sigue abierto es esto.

- **Push después del logout.** `AuthService.logout()` no llama a
  `/push/desuscribir` —el endpoint existe y no tiene consumidor— ni da de baja la
  suscripción del `SwPush`. Mitigado a medias: `guardarSuscripcion` reasigna por
  `endpoint`, así que la siguiente agente que abra el inbox se la lleva. Entre
  medias, un equipo compartido sigue recibiendo nombre de paciente y resumen del
  mensaje a nombre de quien ya salió.
- **`PushService.enviarATodosLosAgentes` es código muerto sin un solo filtro.**
  Cero llamadas en `src/`; hace `findMany()` **sin `where`**. Si alguien lo
  vuelve a llamar manda datos de paciente a todas las suscripciones, RECEPCION
  incluida — que es justo lo que el aislamiento por línea impide en el resto.
- **Dependencias, sin cambios desde el 5/9.** `xlsx` 0.18.5 sigue con `fix: no` y
  está en el camino real de importación; `multer` 2.0.2 clavado por
  `@nestjs/platform-express`. Frontend limpio, 0 avisos. **Trampa:** `npm audit`
  propone «arreglar» Prisma bajando a 6.19.3, que es un downgrade desde 7.10.0.
- **`temporal-polyfill` sigue sin declarar** en el `package.json` del frontend.
- **Índice duplicado** `@@unique([anio, mes])` + `@@index([anio, mes])` en
  `schema.prisma:641-642`.
- **`buscarMensajes` del servicio frontend sigue sin consumidor**; el endpoint
  backend existe y está probado. Conectar o decidir su alcance, no borrar a ciegas.
  Es de la misma familia que F10 —buscar en el chat solo mira los mensajes que el
  navegador tiene cargados, así que un resultado vacío no significa que no
  exista— pero el informe maestro lo clasifica en §17 como integración
  incompleta, no como F10. **Queda anotado como límite conocido**, sin corregir.
- **`Temporal` global de Schedule-X** (ver la sección de cierre): hallazgo de
  compatibilidad, fuera de F10 y sin decidir.

No se pudo comprobar desde aquí, y sigue anotado abajo: las dos
`ReglaClasificacion` con el mismo patrón y el dump de 20 bytes en `/root` del
servidor. Los dos son datos de producción.

## F06 — CERRADO

Cierre técnico aceptado por el usuario. Commits publicados por push normal:
**F06-R1: CERRADO** en `8faa263`; **F06-R2: CERRADO** en `b6ec462`.
El alcance de R2 se revisó: solo alta inicial durable y ajustes indispensables
de integración con la ingesta/F06-R1 y ownership F04.

Quedan explícitamente fuera de F06: entrega durable de notificaciones,
recuperación retrospectiva de leads históricos sin identidad fiable,
pruebas contra Meta/R2 reales y despliegue de producción.
Estos límites no impiden el cierre de F06.

La comprobación final conserva las nueve garantías aceptadas: persistencia antes
de confirmar el webhook; deduplicación de mensajes; adjuntos recuperables tras
reinicio con exclusión entre workers; un lead inicial por primer contacto comercial,
recuperable por retry/reinicio; líneas no comerciales sin autoalta; oportunidades
históricas conservadas y F04 vigente. Sin cambios de implementación en este cierre.

Evidencia y límites detallados en [F06-R1](auditoria-f06-r1.md) y
[F06-R2](f06-r2-primer-contacto-durable.md). **Detenerse con Git sincronizado y limpio.
No iniciar F08/F09/F10.**

## 14 de septiembre de 2026 · F06-R2 — CERRADO

Entrega autorizada después del cierre de F06-R1 en `8faa263`.
**Alta inicial durable por conversación (paciente + línea)** mediante
PrimerContactoWhatsapp. Reserva atómica con conversación comercial; activación
atómica con primer mensaje; lead y completado en transacción exclusiva PostgreSQL.
Recupera fallos y reinicios sin duplicar oportunidades ni notificaciones.

Respeta varios números WhatsApp, líneas no comerciales, oportunidades históricas,
deduplicación whatsappMsgId y ownership F04. F06-R1 conserva su implementación;
su fixture solo recibe la nueva dependencia de ingesta.

Validación: **23 nuevas regresiones PostgreSQL**, **425 integraciones / 22 suites**,
**547 unitarios / 37 suites**, build, typecheck, **test:build 9/9**, check:skills y
git diff --check. Migración aditiva probada desde cero y desde schema anterior;
índices/constraints idénticos y lead histórico ficticio conservado.
Los asserts con Excel privados de verificacion-diciembre siguen sin ejecutarse
por faltar CRM_EXCELS_2025_DIR (advertencia preexistente).

Diseño, evidencia, consultas de observabilidad y rollback:
[F06-R2](f06-r2-primer-contacto-durable.md).
El [reproductor histórico](auditoria-f06/recepcion.repro.cjs) ejecuta ahora la suite
PostgreSQL real. No hay despliegue ni cambios en producción/frontend.

**DETENERSE con F06-R2 commiteado y limpio. No iniciar F08/F09/F10.**

---


## 14 de septiembre de 2026 · F06-R1 — CERRADO

**Solo recuperación durable de adjuntos entrantes. Sin despliegue.**
[Contrato, pruebas, riesgos y rollback](auditoria-f06-r1.md).

`TrabajoMediaEntrante` se crea con el mensaje en la misma transacción.
El worker retoma pendientes e interrumpidos sin nuevo webhook; bloqueo
PostgreSQL durante el intento, lote 10/concurrencia 2, plazo de red 60 s y
retry acotado. Conserva la clave determinista y usa PUT condicional en R2:
una respuesta perdida no causa otra publicación efectiva.

Se mantienen el HTTP 200 después de persistir, el 503 por fallo de persistencia,
el aislamiento del lote y la deduplicación por `whatsappMsgId`. No se modifican
frontend, permisos, sesión, lead de primer contacto ni reintentos salientes.

Migración aditiva `20260914234808_media_entrante_durable`, probada desde base
limpia y sobre esquema anterior con mensaje ficticio conservado. PK, FK,
cascada, índice y cinco CHECK verificados en PostgreSQL 16 descartable.

Validación definitiva: **545 unitarias / 36 suites**, **402 integraciones /
21 suites**, incluidas **26 nuevas PostgreSQL**; build, typecheck estricto de
código/tests, `test:build` **9/9**, `check:skills` y `git diff --check`.
Los casos financieros con Excel privados ausentes conservan la limitación
histórica de asserts omitidos; no se cambiaron.

El reproductor de auditoría ejecuta ahora las regresiones PostgreSQL de F06-R2;
F06-R1 también vive en regresiones habituales con PostgreSQL real.

**F06-R1 y F06-R2 están CERRADOS. Detenerse con Git sincronizado y limpio.**
F08, F10 y el resto de auditorías no se retoman automáticamente.

## 14 de septiembre de 2026 · continuación de auditoría F06 — LOCAL

Revisión sobre backend `c793a33` y frontend `2af3575`, sincronizados al comenzar.
**Auditoría y reproducciones; sin cambios funcionales ni despliegue.**

El pendiente describía código antiguo: desde `8ef88c1` el webhook **espera la
persistencia antes del 200** y devuelve 503 ante fallos parciales. Quedan:

- **Adjuntos:** no se persiste el identificador de media y el reenvío sale por
  deduplicación antes de descargar otra vez. Prioridad alta.
- **Lead de primer contacto:** se pierde si falla su INSERT o el mensaje después
  de crear el chat; el reenvío tampoco lo reconstruye. Prioridad media.

[Informe y siguiente entrega](auditoria-f06-recepcion-2026-09-14.md).
[Reproductor](auditoria-f06/recepcion.repro.cjs): un control aprobado y tres
aserciones de recuperación fallidas, fuera de la suite habitual. Build correcto
y **516 unitarias / 33 suites** aprobadas. Sin integración con PostgreSQL ni
servicios reales. En aquel diagnóstico F06 seguía abierto: repetir la ingesta
no recuperaba los efectos pendientes. R1 y R2 cerraron esos hallazgos; véase el
estado vigente al comienzo de este documento.

## 14 de septiembre de 2026 (cierre) · barrido de duplicación — DESPLEGADO

Frontend en **`2af3575`**, verificado contra Vercel: `styles-I3DSGGZR.css` y el
chunk del helper de teléfono **idénticos byte a byte** al build local, con **una
sola** construcción de `wa.me` y **cero** rastro del prefijo `591`. Backend sin
cambios, sigue en `7194843`.

**El fallo que encontró el barrido.** El enlace de WhatsApp estaba escrito
CUATRO veces con dos nombres, y dos copias anteponían el prefijo de Bolivia «si
faltaba». Con un número que ya trae su país eso da un enlace muerto: una
paciente de México (+52 1 55 1234 5678) salía como `wa.me/5915215512345678`
desde Actividades y Ventas, y correcta desde el chat. No fallaba con error —
abría un chat con un número inexistente. El `591` nunca hizo falta:
`Cliente.telefono` siempre llega internacional porque el DTO lo exige con
`@IsPhoneNumber()` sin región.

**Lo demás del mismo barrido** (detector de cuerpos de función idénticos; el
comando queda en `crm-feature-page`): `nombreMes` tenía **seis** copias con tres
fallbacks distintos para un mes fuera de 1-12 —`Mes 13`, `13` y **cadena
vacía**—, y la última dejaba una etiqueta de periodo invisible en Comisiones.
`MESES` vivía en un feature y lo importaba un átomo de `shared/` (dependencia al
revés). Las etiquetas de paciente estaban duplicadas con dos nombres.

De los once candidatos se extrajeron cuatro; los siete restantes son
delegaciones de una línea y se dejaron a propósito. El criterio quedó escrito:
si la duplicación puede dar dos respuestas distintas a la misma pregunta de
negocio, se extrae.

**Además:** el punto de `.crm-linea` pasó a `secondary` (el token declarado para
indicadores); el filtro de líneas del inbox dejó de ser un `<select>` a mano y
desaparece cuando solo hay una línea; y `/lineas-whatsapp` entró a la caché de
referencia, con prueba de que `/lineas-whatsapp/:id` NO se cachea.

Validación: build sin avisos de presupuesto, **142 pruebas frontend / 15 suites**
(eran 98 al empezar el día).


## 14 de septiembre de 2026 (noche) · contexto de campaña de Meta — DESPLEGADO

| Repo | Commit | Cómo se comprobó |
| --- | --- | --- |
| Backend | `7194843` | VPS: binario recompilado 13:23:49, «successfully started», `/health` 200 `baseDatos: ok`, login vacío → 400, periodos sin token → 401, **webhook sin firma / con firma inventada / verify con token malo → 403**, cero errores en el journal |
| Frontend | `4874622` | Vercel sirve `styles-FNQAEN77.css` y `chunk-KOOJTOJY.js` **idénticos byte a byte** al build local, con el banner nuevo dentro |

Respaldo previo: `/root/backups-crm/crm-20260914-132112.sql.gz`, 3.605.549
bytes, con el OK del script. Sin migraciones (el dato vive en `datosExtra`, que
es JSON).

**Se capturaban mal cuatro campos del `referral` de Meta.** Contrastado con la
referencia oficial del webhook (*Text messages webhook reference*, actualizada
el 17-jun-2026):

- `welcome_message.text` **no estaba en el DTO**, así que `whitelist: true` lo
  borraba entero. Es el saludo que el anuncio deja escrito: casi siempre, el
  primer mensaje literal de la paciente. Mismo modo de fallo que
  `SuscribirPushDto` en agosto.
- `media_type`, `thumbnail_url` y `ctwa_clid` estaban declarados pero
  `extraerReferral` no los mapeaba.
- **Fallo de atribución real:** un anuncio de VIDEO no trae `image_url` sino
  `video_url` + `thumbnail_url`. Al mapear solo `image_url`, todos los anuncios
  de video quedaban sin imagen.

`ctwa_clid` se guarda y **no se muestra**: es lo que la Conversions API pide
para atribuir una venta a su campaña, solo llega en este webhook y no se puede
reconstruir después. Hay una prueba que fija que no se filtra a la vista.

**En el frontend, el móvil.** El banner del hilo daba el titular y nada más; el
cuerpo del anuncio vivía solo en el panel lateral, que en el teléfono hay que
abrir aparte. Ahora se pliega: cerrado ocupa lo mismo, y un toque despliega
imagen, cuerpo, saludo y enlace al anuncio.

**Deuda cerrada:** `campanaDe()` estaba duplicada en el hilo y en el panel y las
copias ya habían divergido —siete campos contra cuatro—, así que el mismo chat
mostraba distinto contexto según dónde se mirara. Ahora es `campanaOrigenDe()`
en `shared/models/`, con siete pruebas sobre el contrato de un JSON sin esquema.

Los 423 chats existentes siguen funcionando: todo campo se lee como opcional.
Contrato completo en el skill `crm-conversaciones`.

Validación: backend 516 unitarias / 33 suites (eran 514) y 376 de integración /
20 suites contra PostgreSQL real; frontend 126 / 13 suites (eran 119). Sin
probar contra Meta real ni en navegador, como el resto de esta entrega.


## 14 de septiembre de 2026 (tarde) · pasada de estética — DESPLEGADO

Frontend en **`64eefd9`**, verificado contra Vercel: sirve
`styles-SUIHN2NP.css` (74.174 bytes) **idéntico byte a byte** al build local,
con las cinco utilidades nuevas presentes y cero `sx__` en el CSS inicial (el
tema del calendario sigue viajando en el chunk de Actividades). Backend sin
cambios: sigue en `ead8c16`.

Alcance: Actividades y su calendario, los cajones de Venta y Recordatorio del
chat, `/usuarios` y `/lineas-whatsapp`.

**Dos fallos reales corregidos, no solo estética:**

- **«Recepción» nunca se pintaba como seleccionado** en `/usuarios`, en los dos
  formularios. Era un `<app-button variant="secondary">` mientras los otros
  roles eran `<button>` a mano con estado activo, y ese átomo no sabe pintarse
  activo: elegirlo no daba ninguna señal.
- **El realce de actividad vencida era invisible**: `bg-critical-bg/20` sobre un
  token que ya es un 6% de negro ≈ 1,2%. Se aplicaba; no se veía.

**Lo estructural:** se fueron los siete hexadecimales literales del `.ts` del
calendario (ahora referencian los tokens; se puede porque `setColors()` de
Schedule-X hace un `setProperty` plano, verificado en su fuente); los modales
escritos a mano pasaron a `<app-drawer>` —Venta y Recordatorio del chat llevaban
anchos fuera de la escala y **sin trampa de foco ni Escape**—; y diecisiete
`<button>` maquetados a mano pasaron al átomo. Nuevos: `<app-switch>` (era el
único control que seguía siendo un checkbox nativo, y enciende el envío real de
WhatsApp a pacientes), `variant="critical"` en `<app-button>`, y las utilidades
`.crm-tipo` / `.crm-accion-enlace` / `.crm-vencida` / `.crm-segmento`.

Pendiente anotado: el control segmentado vive en **siete** plantillas; se migró
en Actividades y Usuarios, faltan cinco (Ventas, Tipo de cambio, Ventas por
agente, Configuración de comisiones, Planilla y el sidebar de Conversaciones).

**Aviso que no conviene perder:** esta entrega es puramente visual y **no se
probó en navegador** —la regla del proyecto lo prohíbe—, así que está verificada
compilando, leyendo y comparando los bytes servidos. Si algo se ve mal, el
commit es único a propósito: `git revert 64eefd9` deshace la pasada entera.

Validación: build sin avisos de presupuesto, 119 pruebas frontend / 12 suites
(eran 98 esta mañana), inicial 402,73 kB / 105,91 kB.


## 14 de septiembre de 2026 · rendimiento de arranque, campana y webhook — DESPLEGADO

Todo lo de abajo está **commiteado, empujado y en producción**, verificado en el
servidor y en Vercel, no inferido de Git.

| Repo | Commit | Dónde se comprobó |
| --- | --- | --- |
| Backend | `ead8c16` | VPS: binario recompilado 10:57:16, «Nest application successfully started», `/health` 200 `baseDatos: ok`, login sin cuerpo → 400, periodos sin token → 401, cero errores en el journal |
| Frontend | `47658cc` | Vercel sirve `styles-ZJURO4VW.css` de **72.558 B** (antes 100.985) con **cero** reglas `sx__` |

Respaldo previo al despliegue: `/root/backups-crm/crm-20260914-105405.sql.gz`,
3.602.885 bytes, con el OK del script. Sin migraciones pendientes.

**Backend** — un `phone_number_id` desconocido ya no devuelve 503 (ver la sección
siguiente). **Frontend** — tres cosas:

1. `PreloadAllModules` → `PreloadPorRol`. El precargador de Angular no consulta
   `canActivate` (comprobado en la fuente 21.2.22), así que una agente se bajaba
   **109,6 kB gzip** de pantallas de ADMIN que no puede abrir.
2. El tema de Schedule-X sale del paquete inicial: **429,37 → 401,11 kB brutos**,
   **109,88 → 105,71 kB transferidos**.
3. Presupuestos de `angular.json` ajustados a la realidad (avisa a 415 kB, falla
   a 440), en vez de 500 kB/1 MB que dejaban 99 kB de deriva silenciosa.

**Y el bug que reportó el usuario: la campana no se enteraba de lo que pasaba
fuera de ella.** Completar una reunión desde la página dejaba el badge con el
número viejo hasta el respaldo de 60 s. La campana (layout, montada siempre) y
la página tenían cada una su `httpResource` del mismo `/actividades/resumen`, y
solo quien mutaba recargaba lo suyo; «Actividad Rápida» desde el chat tenía el
mismo fallo. La invalidación pasó al servicio (`ActividadesService.cambios`).
Se revisó si el patrón se repetía: de los seis recursos que piden dos
componentes, los otros cinco son páginas distintas —nunca montadas a la vez— y
el layout no tiene más estado remoto. Regla en `crm-feature-page`.

Pruebas: backend 514 unitarias / 376 integración; frontend 119 / 12 suites
(eran 98). Sigue sin probarse contra Meta real ni en navegador.


## 14 de septiembre de 2026 · líneas de WhatsApp

**Corrección posterior del mismo día · el 503 del número desconocido.** El
webhook contaba un `phone_number_id` no registrado como fallo de persistencia y
devolvía 503. El 503 es correcto para un fallo transitorio —Meta reintenta y
entra— y venenoso para uno permanente: el reintento de un número sin dar de alta
falla idéntico para siempre y Meta termina desactivando la suscripción. Como las
cuatro líneas comparten una app y un `META_APP_SECRET`, eso dejaba mudas a las
cuatro, incluida la comercial. Y la ventana la abre el propio procedimiento de
alta, que suscribe la app a la WABA antes de registrar el Phone Number ID.

Ahora `LineasWhatsappService.desdeWebhook` devuelve `null` para «no es nuestro»
y sigue lanzando para un error de base; el controlador descarta el primero con
200 y mantiene el 503 para el segundo. El aviso incluye `phone_number_id`,
`display_phone_number` (declarado en el DTO solo para esto, porque `whitelist` lo
borraría) y los ids descartados. Regla escrita en `crm-backend-module`
§«Un 503 solo vale para fallos TRANSITORIOS».

**De paso, una prueba flaky que había que quitar de en medio.**
`lineas-whatsapp.integracion` → «push usa el mismo alcance que REST» fallaba **2
de cada 4 corridas** de la suite completa (nunca al correrla sola), y ya lo hacía
antes de este cambio: se comprobó corriendo el código original cuatro veces. No
era un fallo del producto. Exigía un total exacto de llamadas al mock de push,
pero `crm_test` es compartido y otras tres suites —`autorizacion-http`,
`inbox-escala`, `conversaciones`— crean usuarios **con acceso a la línea
comercial**; si alguna corre antes (el orden de archivos de jest no es estable
entre corridas) esos usuarios son destinatarios legítimos de un chat comercial
sin asignar y el conteo se rompe. Ahora se filtra por el `tag` del chat y se
afirma explícitamente quién entra (ventas + admins) y quién NO (las dos
recepciones y el agente sin líneas), que es más fuerte que el conteo que
sustituye. Cinco corridas limpias seguidas.

Importa más de lo que parece: una prueba que falla la mitad de las veces enseña
a ignorarla, y ésta cubre justamente el aislamiento de avisos entre líneas.

Verificado en esta máquina: build correcto, **514 unitarias / 33 suites**
(eran 509) y **376 casos de integración / 20 suites** contra PostgreSQL real en
:5433 (cinco corridas seguidas). Cinco pruebas nuevas del controlador —incluida la que fija que un fallo
transitorio SIGUE siendo 503— y las dos de integración de línea desconocida
reescritas a 200 conservando lo que de verdad protegen: no se persiste nada y
nada cae en ventas. **Desplegado en `ead8c16`** (ver la cabecera de este archivo).

Se implementaron catálogo de cuatro líneas (actual + tres nuevas), rol RECEPCION,
asignación explícita por usuario y aislamiento de conversaciones en backend y frontend.
La migración conserva el historial comercial. [Diseño, activación y límites](lineas-whatsapp.md).
Las tres líneas nuevas quedan desactivadas hasta completar el alta en Meta y sus credenciales.
Backend desplegado el 14-09-2026 (`8ef88c1`) con migración y respaldo verificado.
Se corrigió el desfase con Vercel: frontend publicado antes de actualizar el VPS.
Producción conserva 423 chats y 3.160 mensajes en ventas; los dos agentes conservan acceso.
Las tres líneas nuevas siguen pendientes de conexión real con Meta.
Validación: builds correctos, 98 pruebas frontend, 509 unitarias backend y 376 casos de integración reportados; migración con historial ficticio comprobada. Se conserva la limitación de las pruebas financieras sin Excel privados.

La base de trabajo ya incluía en Git los cambios de Finanzas mencionados abajo.
Las referencias siguientes a trabajo sin commitear corresponden al handoff histórico del día 10.

## Handoff histórico del 10 de septiembre

**10 de septiembre de 2026 · único handoff de ambos repositorios.**

**Hay trabajo SIN COMMITEAR y SIN DESPLEGAR en las dos máquinas de este
directorio**: la auditoría del módulo Finanzas de hoy (ver más abajo). Lo
anterior —F07, F06 entrega 2 y F09— sí está commiteado, empujado y en
producción desde el 9 de septiembre.

## Auditoría del módulo Finanzas — 10/9/2026, en el árbol de trabajo

Cuatro correcciones y una medición, todas dentro de `planilla-comisiones` /
`features/finanzas`. **Nada de esto está commiteado ni desplegado todavía.**

| # | Qué estaba mal | Dónde |
| --- | --- | --- |
| 1 | La caché de `AnaliticaComisionesService` (60 s por periodo) **solo la invalidaba `calcular()`**. Importar, ajustar una fila, reclasificar, borrar el mes o cambiarlo de estado la dejaban vieja — y como el Excel arma «Resumen», «Distribución» y «Rankings» con esa misma llamada cacheada, **el archivo que se firma podía declarar una liquidación que `invalidarCalculo()` acababa de borrar**. | `planilla-comisiones.service.ts` (nuevo `invalidarCachesDelPeriodo()`, un solo punto para las 9 mutaciones) |
| 2 | La pestaña Analítica mostraba **cuatro** cubos de comisión (A, B, C, bonos) bajo un KPI con el total, que son **cinco**: faltaba Tipo A (RA). El backend lo devolvía; `ResumenAnalitica` no lo declaraba, así que se caía en silencio y las tarjetas sumaban menos que el total. | `analitica.model.ts`, `analitica.page.html` |
| 3 | La vista previa de «Selección de planes» contaba las filas **excluidas** del cálculo, que el motor no ve. Con 5 paquetes (1 excluido) y objetivo 4 marcaba 1 plan como «comisiona» mientras la planilla pagaba **cero**. | `agrupar-planes.ts` (regla extraída del `computed` de la página y probada), `seleccion-planes.component.html` |
| 4 | `hojasPorVendedora()` hacía un `findMany` **por vendedora** dentro de la descarga del Excel. | `exportacion-comisiones.service.ts` |
| 5 | El código afirmaba que el Excel va en streaming y que «500 filas y 50.000 cuestan lo mismo en RAM». Es al revés: `new Workbook()` construye todo en memoria. Medido: 500 filas → 116 MB RSS; **10.000 → 440 MB, por encima del `MemoryMax=400M`**. Documentado, no cambiado: a la escala real sobra margen. | cabecera de `exportacion-comisiones.service.ts` y del endpoint |

También corregido: `analitica.model.ts` escribía a mano el enum de estados con
tres valores cuando el ciclo de vida tiene cinco; ahora usa `EstadoPeriodo`
generado.

**Verificado en esta máquina:** backend `npm run build` verde, **508 unitarias /
33 suites** (eran 505); frontend typecheck, `npm run build` verde y **91 tests /
10 suites** (eran 80). Los tres arreglos con test propio se comprobaron
rompiéndolos a propósito primero — el de reparto de ventas del Excel **no
fallaba** en su primera versión y hubo que reescribirlo con `incluirOcultas`
para que discriminara.

**Lo que NO se pudo verificar aquí:** no hay PostgreSQL en el 5433 de esta
máquina, así que **las suites de integración no se ejecutaron**. Sí se comprobó
que compilan: los siete specs que construyen `PlanillaComisionesService`
recibieron el argumento nuevo (`analitica`, entre `resumenAnual` y `tipoCambio`)
y un typecheck de `src/**/*.ts` con tipos de jest pasa limpio.

> Antes de desplegar estos cambios, ejecutar `test:integracion` completo contra
> PostgreSQL descartable.

Esa verificación **ya se hizo**, el 16 de septiembre: 425 casos / 22 suites en
verde contra PostgreSQL 16.15 descartable, con las 44 migraciones aplicadas desde
cero (ver la sección del 16/9 al principio de este archivo). La receta de la base
descartable está en
[crm-backend-arquitectura §8](../.claude/skills/crm-backend-arquitectura/SKILL.md);
recordar que `test:integracion:preparar` **borra `crm_test`**.

### Lo que esta auditoría NO resolvió, a propósito

- **`limite: 100` en la vista de planes.** Es el tope de paginación del backend.
  Si un mes trajera más de 100 planes de un tipo, la pantalla vería solo los
  primeros y calcularía un cupo corto **sin avisar**. Comprobado: el mes más
  cargado hasta hoy trae 30. Documentado en §7b del skill `crm-finanzas`, no
  corregido.
- **El Excel sigue con `Workbook`, no con `WorkbookWriter`.** El techo real está
  medido y escrito (fila 5 de la tabla de arriba y §8e del skill). A la escala
  de hoy sobra margen; cambiarlo ahora sería reescribir el generador entero sin
  necesidad. El disparador para hacerlo es que una exportación tarde varios
  segundos.
- **`verificacion-diciembre` sigue saliendo PASS sin comparar nada** mientras
  `CRM_EXCELS_2025_DIR` no esté definida. Es la única prueba que contrasta el
  motor contra lo que administración pagó de verdad. Aquí solo se le adaptó el
  constructor —infraestructura, forzada por la inyección nueva—; el problema de
  fondo sigue igual que en el handoff anterior.

## Lo anterior (9 de septiembre)

**Todo lo trabajado está commiteado, empujado y EN PRODUCCIÓN.** No hay trabajo
a medias, ni ramas, ni cambios sin subir en ninguna de las dos máquinas. Cerrados
ese día: F07, **F06 entrega 2** (mitad saliente) y **F09**.

Antes de trabajar, `git fetch` en ambos repos y leer este archivo. El saneamiento
del 8 de septiembre se conserva abajo como baseline.

## Backend / Frontend

Dos repositorios Git independientes, hermanos, rama `main`; sin submódulos,
stashes ni worktrees extra. El directorio padre **no está versionado**.

| Repositorio | Remoto | Último checkpoint verificado |
| --- | --- | --- |
| Backend | https://github.com/velasquezren/backend-crm-montalvo.git | `3a03678b834ca8f7bd5d9abe52e12e2290de073c` — punta de `main`. **Desplegado: `7704e7e`**; lo posterior es solo documentación. |
| Frontend | https://github.com/velasquezren/frontend-crm-montalvo.git | `2d4287ad258c897cf05d51fd5327bc43efc5bd86` — punta de `main`, **desplegado** en Vercel. |

Baseline anterior, por si hace falta volver: backend `e91a2d0`, frontend `8e46f5a`.

## Producción — consultada y desplegada el 9/9/2026 22:52 (-04)

**Ya no hay que suponer nada: se miró.** Backend en `7704e7e`, frontend en
`2d4287a` (Vercel), ambos verificados en la máquina.

| Comprobación | Resultado |
| --- | --- |
| `systemctl is-active crm_backend` | `active`, arranque limpio en el journal |
| `GET /health` | 200, `baseDatos: "ok"` |
| `POST /auth/login` con `{}` | **400** — ValidationPipe vivo |
| `GET /planilla-comisiones/periodos` sin token | **401** — guard vivo |
| Errores en el journal desde el arranque | **ninguno** |
| Esquema | enum `EstadoMensaje` con `INCIERTO`, `intentosEnvio`, `proximoIntento`, `Mensaje_proximoIntento_idx` |
| Respaldo previo | `/root/backup-crm-20260909-224636.sql.gz`, 3,5 MB, verificado |

**Corrección al handoff anterior:** este documento afirmaba que había *dos*
migraciones sin aplicar. Era falso: `20260907180000_sesion_revocable` (F05) ya
constaba aplicada en producción. La única pendiente era la de F06 e2, y ya se
aplicó. PostgreSQL de producción es **16.14**, así que el `ALTER TYPE ... ADD
VALUE` de esa migración corre dentro de la transacción sin problema.

**El orden de despliegue de F09 no se cumplió, y conviene saber por qué.** La
regla es backend primero (su payload es aditivo; el Service Worker anterior lo
sigue entendiendo) y frontend después. Pero **Vercel despliega solo con el push**:
el frontend estuvo en producción a los 33 s del `git push`, unos ocho minutos
antes que el backend. En esa ventana, quien recargara la app quedaba con ngsw
activo recibiendo el payload viejo — es decir, sin notificaciones. La ventana ya
está cerrada. Para la próxima: **si el orden importa, se empuja el backend, se
despliega, y solo entonces se empuja el frontend.**

Queda una comprobación que no se puede hacer desde aquí: **que llegue una
notificación de verdad con la app cerrada**. F09 no se probó en navegador.

El SHA del checkpoint completo del backend es el commit que contiene esta
versión del handoff: `git log -1 --format=%H -- docs/ESTADO_ACTUAL.md`.
El saneamiento no modifica lógica, dependencias, schema ni migraciones. Se
integraron por merge los commits remotos frontend `0fa33fa` y `4f7dff9` durante
la sesión; se conserva su corrección de calendario, sin ampliarla.
Node **22.23.2** (`.nvmrc`), npm **10** (verificado con 10.9.8), PostgreSQL **16**.
El frontend declara `packageManager: npm@10.9.7`; ambos lockfiles se reconstruyen
con npm 10.9.8 sin modificarse. No copiar node_modules ni builds entre máquinas.

## Los diez findings, uno por uno

Identificadores **F01–F10 de §3** del [informe maestro](auditoria-arquitectonica-2026-09-05.md).
Las entregas 0–9 de §19 tienen otra numeración; no confundirlas.

**«CERRADO» significa corregido en código y con pruebas**, no desplegado. Qué
hay en producción está en la tabla del principio de este archivo.

| Hallazgo | Estado verificado / implementación y protección |
| --- | --- |
| F01 | **CERRADO**. `428cb3f`; `tsconfig.build.json`, `scripts/verificar-build.mjs` y `verificar-build.test.mjs` (build limpio/consecutivo/sin emisión). |
| F02 | **CERRADO**. `775abbd`; `planilla-comisiones.service.ts`, `importacion-atomica.integracion.spec.ts`; [evidencia](auditoria-f02.md). |
| F03 | **CERRADO**. `775abbd`; `transaccion-periodo.ts`, servicios de planilla/cálculo/configuración; `consistencia-periodo.integracion.spec.ts`, `cierre-periodo.spec.ts`; [evidencia](auditoria-f03.md). |
| F04 | **CERRADO**. `775abbd`; DTO de perfil, servicios de actividades/clientes/ventas; `autorizacion-http.integracion.spec.ts`; [matriz](auditoria-f04.md). |
| F05 | **CERRADO**, revalidado punto por punto. `775abbd` + frontend `9aa073a`. Tipo de credencial (`esCredencial`); el refresh **no sale en el JSON** (se desestructura en `auth.controller.ts`); `validarSesion` consulta la sesión en cada petición y rechaza por usuario inactivo, `versionSesion` distinta o rol del token que no coincide con la base; un fallo de PostgreSQL es 5xx, no 401. **WebSocket cerrado en sus dos mitades**: el cliente lee el token en cada handshake y reconecta tras refrescar; el servidor desconecta el socket al expirar la credencial. [Contrato](auditoria-f05.md). |
| F06 | **CERRADO**. F06-R1: `8faa263`; F06-R2: `b6ec462`. Entrega 1 y despacho saliente cerrados. [Adjuntos durables](auditoria-f06-r1.md). Entrega 1: `58bae3a`, [evidencia](auditoria-f06.md). Entrega 2: `ResultadoEnvio` + `EstadoMensaje.INCIERTO` + `ReintentoSalienteService` + `biz_opaque_callback_data`; migración `20260909210000_envio_incierto_y_reintento`; [evidencia](auditoria-f06-entrega2.md). |
| F07 | **CERRADO**, revalidado. `b702fa0`. No queda ningún comparador `equal` en `inbox` ni en `detalle`: los dos usan la igualdad por referencia de `httpResource`, con el porqué escrito sobre el recurso. Regresiones para los escenarios que nombraba el informe —entrega con misma fecha y cantidad, media que renueva su URL firmada, ficha cambiada sin tocar la conversación, agente con igual timestamp— en `conversaciones-state.service.spec.ts`. **No reproducible hoy.** Sin desplegar. |
| F08 | **CERRADO**. Inbox ya estaba; Planilla en `6e16040` (frontend, desplegado): generación por panel en `refrescarPanelesDelPeriodo`/`cargarConsolidado`, y cuatro estados reales donde el `catch → null` mezclaba «falló la red» con «no hay liquidación». |
| F09 | **CERRADO** en sus dos mitades. (1) Un solo Service Worker, el de Angular, con `SwPush` encima; protegido por tres reglas de `verificarServiceWorkerUnico` en `check:skills` —no por un spec, porque el fallo necesita un navegador real con dos SW compitiendo—; [evidencia](auditoria-f09.md). (2) **Ciclo de vida de la suscripción**: `logout()` da de baja el dispositivo (`f0acb57`), `enviarATodosLosAgentes` eliminado y `enviarAUsuario` filtra `activo` (`b6f61e1`), contrato del endpoint fijado (`0f278cf`). **No verificado en navegador**, decisión consciente. Sin desplegar. |
| F10 | **CERRADO**, los tres corregidos. Calendario por rango visible (`cdc0f22`). Historiales: resumen agregado sobre todo el historial y `limiteLista` (`3fddd28` + `7da0397`) — el «máximo real 20» del comentario era falso: 31 en un solo mes. Cursor `(createdAt, id)` (`b09132b` + `9c204bc`). Sin desplegar. |

No inferir el despliegue desde Git — pero **el 9/9/2026 sí se consultó**: ver
la sección de producción más arriba. F05 estaba desplegado y su migración
aplicada, al contrario de lo que suponía este documento.

## Segunda auditoría Performance / UX Premium

**EN ANÁLISIS, sin implementación de esa etapa en main.** Los commits
`73ec3f7` (backend) y `b4c8a43` (frontend) agregaron únicamente documentación y
evidencias. No había modificaciones locales ni features parciales que revertir.
Los diseños UI anteriores son trabajo publicado, no cambios abandonados de esta etapa.

Conservar [el diagnóstico histórico](auditoria-f06-etapa2.md) y
`auditoria-etapa2/`: pruebas de carrera del inbox, sesión cruzada, colisión PWA,
mediciones locales (~819 ms en búsqueda) y capturas 1440/1024/390 con datos
sintéticos. Los scripts dependen de rutas macOS, Playwright externo, `/tmp` y
`crm_audit`: **son archivo histórico, no pasos necesarios para levantar o validar
el proyecto**. Parametrizarlos antes de reusar la metodología en esa auditoría.
No ejecutar su script histórico de despliegue ni confundirlo con la receta vigente.

## No tocar

- Monolito Nest, Prisma directo y Angular por funcionalidades; ninguna capa nueva.
- Publicación atómica F02 y lock mensual + REPEATABLE READ F03; conservar auditoría transaccional.
- Fórmulas financieras, fotografía de configuración y TC del periodo; FIJO manda sobre la serie diaria.
- Sesión revocable (`type`, `sid`, `versionSesion`) en HTTP y WebSocket.
- `enSegundoPlano`: captura fallos, **no garantiza entrega ni reintento** por sí
  solo. Para el envío saliente esa garantía la da ahora el estado en la fila más
  `ReintentoSalienteService`; los demás caminos que envuelve siguen sin recuperación.
- **Solo se reintenta lo que consta que no salió.** Un `INCIERTO` no se reenvía
  nunca por cuenta propia: se resuelve con el `statuses` de Meta correlacionado
  por `biz_opaque_callback_data`. Decisión del usuario, no detalle de
  implementación — reenviarlo duplica el mensaje en el WhatsApp de la paciente.
- Calendario de Actividades sin `@defer` (`4f7dff9`): volver a diferirlo exige
  reproducir primero el fallo de visualización; ver skill `crm-rendimiento`.
- Versiones actuales de Angular/Nest/Prisma/xlsx; upgrades en trabajo independiente.

## Cómo continuar

**La auditoría F01–F10 está cerrada en código.** No queda ningún finding por
atender: lo que viene después es trabajo nuevo, no continuación de esta.

Lo único pendiente de ella es **desplegar**, y es una decisión aparte. Ver la
tabla del principio: producción lleva nueve commits de retraso en el backend y
dos migraciones de la auditoría sin aplicar, y el frontend nuevo depende de
contratos del backend nuevo. Backend primero, siempre.

Aparte de la auditoría, y sin mezclarla con ella, está **Agenda / Actividades
(A1–A5)**: terminada en la rama `agenda-actividades-v2`, sin llevar a `main` y
sin desplegar. Suma una tercera migración pendiente en producción. Su sección
propia dice qué incluye y qué NO soporta.

Lo que sigue sin verificarse es lo de fuera del proceso: **nada de F06 se probó
contra Meta de verdad** —todo el camino externo va con `fetch` simulado— ni nada
en un navegador. Es una diferencia real respecto a F02–F05, aceptada a
conciencia.

El histórico de cada entrega, con su evidencia y sus límites, queda más abajo en
este mismo archivo, del más reciente al más antiguo. Las secciones fechadas son
un registro de lo que se hizo aquel día: cuando alguna diga «no iniciar F08/F09/F10»
o dé un finding por abierto, manda la cabecera de este archivo, no ellas.

## Límites conocidos, que NO son findings

Ninguno de estos abre un F11. Son límites que se conocen, se aceptan y conviene
no olvidar; están aquí precisamente para que nadie los redescubra como hallazgos.

- **`verificacion-diciembre` sale PASS sin comparar nada** mientras falte
  `CRM_EXCELS_2025_DIR`. Es la única prueba que contrasta el motor contra lo que
  administración pagó de verdad, así que acota la confianza en F02/F03 sin
  reabrirlos. Definir esa variable antes de tocar comisiones.
- **`buscarMensajes` del frontend sigue sin consumidor**: buscar dentro de un
  chat solo mira los mensajes que el navegador tiene cargados, de modo que un
  resultado vacío no prueba que no exista. El endpoint backend existe y está
  probado. Es §17 del informe maestro —integración incompleta—, no F10.
- **`Temporal` global de Schedule-X.** `@schedule-x/calendar` lo usa como global
  libre: lo declara `peerDependency` y no lo importa nunca en su `dist/core.js`,
  y nada en esta app instala ese global. Hoy funciona porque el navegador lo trae
  nativo; en uno que no, la vista Calendario revienta con `ReferenceError`.
  Compatibilidad, sin decidir.
- **Dependencias**: `xlsx` 0.18.5 sin arreglo disponible y en el camino real de
  importación; `multer` 2.0.2 clavado por `@nestjs/platform-express`;
  `temporal-polyfill` sin declarar en el frontend. Trampa: `npm audit` propone
  «arreglar» Prisma bajando a 6.19.3, que es un downgrade desde 7.10.0. Carril
  propio, fuera de la auditoría.
- **Nada se ha probado en navegador**, por la regla del proyecto. Afecta sobre
  todo a F09 y F10.
- **Datos de producción, no comprobables desde aquí.** Dos reglas
  `ReglaClasificacion` con el patrón `Colocación de T de Cobre o DIU`, misma
  prioridad y clasificaciones distintas (CONSULTA y ECOGRAFIA): cuál gana queda
  al azar, y solo administración puede elegir una y borrar la otra. Y en `/root`
  del servidor hay un `backup-crm-20260909-210306.sql.gz` de 20 bytes —un dump
  vacío por error de credenciales—; el bueno es el de 21:03:21. Conviene mirarlo
  y limpiarlo a mano.

## Verificaciones

Instalar ambos repos como hermanos. [Frontend](../../frontend-crm-montalvo/README.md)
y [arranque backend](../CLAUDE.md#instalación-y-arranque-local-linux--macos).

```bash
# Desde backend-crm-montalvo
npm ci
node node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit --incremental false
npm test -- --runInBand
npm run test:build
npm run build
# Solo con PostgreSQL descartable propio en :5433 (borra crm_test):
# receta Linux/macOS: .claude/skills/crm-backend-arquitectura/SKILL.md §8
npm run test:integracion:preparar && npm run test:integracion

# Desde frontend-crm-montalvo
npm ci
node node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit
npm test -- --watch=false
npm run build
```

Verificación F07 del 9 de septiembre: **80 tests frontend (9 suites)**, incluidos
11 de F07, y typecheck correctos. El resultado del build queda registrado en
[auditoria-f07.md](auditoria-f07.md).

Verificación F06 entrega 2, mismo día: **499 unitarias backend (32 suites)**,
`npm run build` y `test:build` 9/9; **integración 19 suites / 354 casos** contra
PostgreSQL 16 descartable, en orden normal e inverso, con la migración aplicada y
el esquema comprobado. Frontend: typecheck, 80 tests y build. Detalle y los
experimentos de "romper a propósito" en
[auditoria-f06-entrega2.md](auditoria-f06-entrega2.md).

**Aviso que conviene no olvidar:** `verificacion-diciembre` sale **PASS** sin
comparar nada mientras `CRM_EXCELS_2025_DIR` no esté definida — lo dice por
consola («los asserts de esta suite NO se ejecutaron»), pero el conteo de Jest
la cuenta como aprobada. Antes de tocar comisiones, definir esa variable.

Los builds incluyen check:skills; frontend también check:tipos; backend exige
`dist/main.js`. En Linux pasaron 69 tests frontend, 472 unitarios backend,
9 comprobaciones test:build y 18 suites/346 casos reportados de integración,
en orden habitual e inverso sobre la misma base. **Los conteos incluyen casos
que retornan sin aserciones cuando faltan Excel**: no equivalen a conciliación real.
Las suites se ejecutan en serie; no correr dos procesos contra el mismo crm_test.

## Límites y deuda fuera de este saneamiento

- **Excel privados**: faltan los conjuntos completos de 2025/2026. Exportar
  `CRM_EXCELS_2025_DIR` y `CRM_EXCELS_2026_DIR` desde un respaldo seguro antes de
  reconciliar comisiones; Jest no carga automáticamente el `.env` para estas rutas.
  Diciembre necesita octubre.xlsx, noviembre.xlsx y diciembre.xlsx. Los dos Excel
  sueltos del directorio padre no bastan. No versionar datos de pacientes.
- **Respaldo privado pendiente de confirmar**: `.env`, Excel y configuraciones de
  herramientas del padre no viajan por Git. No son requisitos de build; sí debe
  conservarse fuera de Git lo necesario para integraciones reales y conciliación.
  Tampoco puede Git recuperar cambios de la Mac que nunca se hayan publicado.
- **Scripts operativos antiguos**: `scripts/seed-admin.js` e `import-pacientes.js`
  usan `@prisma/client` anterior al cliente generado actual. Conservar su método
  histórico; no ejecutarlos sin adaptar y probar en una fase de tooling.
- **Imports transitivos**: frontend usa `temporal-polyfill`; CLI Prisma usa
  `dotenv/config`; backend usa tipos/augmentación `express`. Llegan por el lockfile,
  pero no están declarados directamente. Corregir su declaración en una fase de
  dependencias autorizada; aquí no se cambiaron versiones ni manifests.
- **Los bugs frontend que este archivo llegó a listar están todos cerrados**,
  comprobado el 16/9: los dos Service Workers con F09, las respuestas tardías del
  inbox y de Planilla con F08, la suscripción push que el logout no daba de baja
  también con F09, y la igualdad parcial de `detalle` con F07. Este apartado ya no
  tiene nada abierto que aportar sobre ellos.
