# Estado actual

## 14 de septiembre de 2026 · F06-R1 — IMPLEMENTADO Y VALIDADO LOCALMENTE

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

El reproductor de auditoría conserva solo F06-R2 (dos fallos esperados);
F06-R1 vive en regresiones habituales con PostgreSQL real.

**DETENERSE al dejar esta entrega commiteada y limpia. F06-R2 permanece abierto.**
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
servicios reales. F06 sigue abierto: repetir la ingesta actual no recupera los
efectos pendientes, aunque se guarde el webhook entero.

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

Esa verificación **está pendiente**: no se ha ejecutado y no debe darse por
hecha. La receta de la base descartable está en
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
- **`reintento-saliente.service.spec.ts` importa `Logger` sin usarlo** (F06 e2,
  commit `f2fc042`). De antes y sin relación con Finanzas. Una línea; no rompe
  el build porque `tsconfig.build.json` excluye los specs.

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

## Fases cerradas y pendientes

Identificadores **F01–F10 de §3** del [informe maestro](auditoria-arquitectonica-2026-09-05.md).
Las entregas 0–9 de §19 tienen otra numeración; no confundirlas.

| Hallazgo | Estado verificado / implementación y protección |
| --- | --- |
| F01 | **Cerrado**. `428cb3f`; `tsconfig.build.json`, `scripts/verificar-build.mjs` y `verificar-build.test.mjs` (build limpio/consecutivo/sin emisión). |
| F02 | **Cerrado**. `775abbd`; `planilla-comisiones.service.ts`, `importacion-atomica.integracion.spec.ts`; [evidencia](auditoria-f02.md). |
| F03 | **Cerrado**. `775abbd`; `transaccion-periodo.ts`, servicios de planilla/cálculo/configuración; `consistencia-periodo.integracion.spec.ts`, `cierre-periodo.spec.ts`; [evidencia](auditoria-f03.md). |
| F04 | **Cerrado**. `775abbd`; DTO de perfil, servicios de actividades/clientes/ventas; `autorizacion-http.integracion.spec.ts`; [matriz](auditoria-f04.md). |
| F05 | **Cerrado en código**. `775abbd` + frontend `9aa073a`; auth/guard/gateway/interceptor; `sesion-http.integracion.spec.ts`, `auth.service.spec.ts`, tests frontend de auth/interceptor/realtime; [contrato](auditoria-f05.md). |
| F06 | **Entrega 1 y despacho saliente cerrados; F06-R1 implementado y validado localmente; F06-R2 pendiente**. [Adjuntos durables](auditoria-f06-r1.md). Entrega 1: `58bae3a`, [evidencia](auditoria-f06.md). Entrega 2: `ResultadoEnvio` + `EstadoMensaje.INCIERTO` + `ReintentoSalienteService` + `biz_opaque_callback_data`; migración `20260909210000_envio_incierto_y_reintento`; [evidencia](auditoria-f06-entrega2.md). |
| F07 | **Cerrado en código, commiteado y empujado (`b702fa0`); sin desplegar**. Retirados los comparadores parciales de `inbox` y `detalle`; 11 pruebas de regresión en `conversaciones-state.service.spec.ts`; [evidencia](auditoria-f07.md). |
| F08 | Diagnosticado, pendiente: respuestas tardías que pisan selección/filtros. |
| F09 | **Cerrado**. Un solo Service Worker (el de Angular) + `SwPush`; el payload de push pasa por `common/push/cuerpo-push.ts`; regla nueva en el `check:skills` del frontend; [evidencia](auditoria-f09.md). **No verificado en navegador**, y se decidió dejarlo así: el fallo se demostró leyendo el `ngsw-worker.js` que se despacha, y el arreglo, comprobando que el payload cumple lo que ese código exige. Si algún día alguien reporta que no le llegan avisos con la app cerrada, empezar por aquí. |
| F10 | Pendiente: completitud de consultas (calendario/historiales). |

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

F07 se atendió por petición explícita del usuario el 9 de septiembre, y a
continuación **F06 entrega 2, en su mitad saliente**: el envío ya distingue "no
salió" de "no se sabe si salió", reintenta solo lo primero y resuelve lo segundo
con el `statuses` de Meta. Ninguno de los dos cambios toca las carreras de F08.

Después se cerró **F09** (dos Service Workers en el mismo scope `/`, que se
sustituían y dejaban el push mudo o `SwUpdate` muerto según cuál quedara activo).
Va antes que la recepción durable a propósito: rompía en silencio lo único que
avisa a una agente cuando escribe una paciente.

**F06-R1 está implementado y validado localmente.** La instrucción vigente del
usuario es detenerse después de commitear y dejar limpio este cambio.
F06-R2 (lead de primer contacto) será otra entrega; no iniciarla, ni F08/F10,
sin la siguiente instrucción. Ver [F06-R1](auditoria-f06-r1.md).

Producción se consultó y se desplegó (ver la sección de más arriba). Lo que sigue
sin verificarse es lo de fuera del proceso: **nada de esto se probó contra Meta
de verdad** —todo el camino externo va con `fetch` simulado— ni en un navegador.
Es una diferencia real respecto a F02–F05, y está aceptada a conciencia, no por
descuido.

### Deuda conocida que no es de código

- **`verificacion-diciembre` sale PASS sin comparar nada** mientras
  `CRM_EXCELS_2025_DIR` no esté definida. Lo avisa por consola —«los asserts de
  esta suite NO se ejecutaron»— pero Jest la cuenta como aprobada. Es la única
  prueba que contrasta el motor contra lo que administración pagó de verdad:
  definir esa variable antes de tocar comisiones.
- **Dos reglas `ReglaClasificacion` con el patrón `Colocación de T de Cobre o
  DIU`**, misma prioridad y clasificaciones distintas (CONSULTA y ECOGRAFIA):
  cuál gana queda al azar. Solo administración puede elegir una y borrar la otra.
- **En `/root` del servidor hay un `backup-crm-20260909-210306.sql.gz` de 20
  bytes** — un dump vacío por error de credenciales, del intento de las 21:03.
  El bueno es el de 21:03:21. No se borró nada: conviene mirarlo y limpiarlo a
  mano.

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
- Los bugs frontend documentados siguen abiertos: `conversaciones-state.service.ts`
  (respuestas tardías/estado), `auth.service.ts` (stores entre sesiones),
  `app.config.ts` + `notificacion-nativa.service.ts` (dos SW). Riesgo: datos visibles
  incorrectos o remanentes de otro usuario y conflictos push/caché; pendientes de
  aislamiento de estado y F08–F09. La igualdad parcial de F07 está corregida.
