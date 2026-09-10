# Estado actual

**9 de septiembre de 2026, 23:00 (-04) · único handoff de ambos repositorios.**

**Todo lo trabajado está commiteado, empujado y EN PRODUCCIÓN.** No hay trabajo
a medias, ni ramas, ni cambios sin subir en ninguna de las dos máquinas. Cerrados
hoy: F07, **F06 entrega 2** (mitad saliente) y **F09**.

Antes de trabajar, `git fetch` en ambos repos y leer este archivo. El saneamiento
del 8 de septiembre se conserva abajo como baseline.

## Backend / Frontend

Dos repositorios Git independientes, hermanos, rama `main`; sin submódulos,
stashes ni worktrees extra. El directorio padre **no está versionado**.

| Repositorio | Remoto | Último checkpoint verificado |
| --- | --- | --- |
| Backend | https://github.com/velasquezren/backend-crm-montalvo.git | `f2fc0424d7aec21020ca354837938530d1fe1613` (F06 entrega 2; verificado sin integración) |
| Frontend | https://github.com/velasquezren/frontend-crm-montalvo.git | `7b45879947a542a10f0b3430d32fb7537c7a333b` |

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
| F06 | **Entrega 1 cerrada; entrega 2 cerrada en el despacho SALIENTE, recepción durable pendiente**. Entrega 1: `58bae3a`, [evidencia](auditoria-f06.md). Entrega 2: `ResultadoEnvio` + `EstadoMensaje.INCIERTO` + `ReintentoSalienteService` + `biz_opaque_callback_data`; migración `20260909210000_envio_incierto_y_reintento`; [evidencia](auditoria-f06-entrega2.md). |
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

**La siguiente tarea prioritaria pendiente es la mitad que queda de F06: la
recepción durable** — persistir el webhook antes de responder 200 y despacharlo
con reintento, porque hoy lo que se pierda procesando no se recupera. La
idempotencia de entrada ya existe (dedupe por wa msg id), pero durabilidad no es
idempotencia. Después de eso, Performance/UX sale de análisis.

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
