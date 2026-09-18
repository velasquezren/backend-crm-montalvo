# Revisión final archivo por archivo — 18/09/2026

Última revisión técnica de la etapa. **No** es auditoría de arquitectura, ni
ronda de optimización, ni búsqueda de features. El criterio fue buscar
inconsistencias, no trabajo: un archivo que funciona y tiene propósito no se
toca, aunque pudiera escribirse más bonito.

Inventario tomado con `git ls-files`, excluyendo `node_modules/`, `dist/`,
`.angular/`, `coverage/`, `.cache/` y `.git/`.

| | Archivos versionados revisados |
| --- | ---: |
| `backend-crm-montalvo` | **401** |
| `frontend-crm-montalvo` | **344** |
| **Total** | **745** |

Reparto: 383 de source productivo, 104 tests, 50 de prisma/migraciones, 153 de
documentación, 9 skills, 9 scripts/tools, 8 assets, 28 de configuración, 1 de
deploy.

**Resultado: 3 archivos corregidos, 0 eliminados.** Todo lo demás quedó
`REVISADO — SIN CAMBIOS`.

## Archivos corregidos

Los tres son documentación. **Ningún cambio de código productivo**, así que no
hubo redespliegue.

| Archivo | Severidad | Qué era falso |
| --- | --- | --- |
| `docs/CAMP-0-campanas-meta-roi.md` | B | La sección «MEDICIÓN REAL — 18/09» presentaba sus porcentajes sin decir que son el estado **anterior** a CAMP-1. Leída hoy, invitaba a tomar el **1,6 % de ingresos atribuibles como cobertura esperada futura**, que es justo lo contrario de lo que mide. |
| `docs/CAMP-0-campanas-meta-roi.md` | B | «CAMBIOS MÍNIMOS — Ninguno se implementa en esta ronda» dejó de ser cierto: los puntos **1 y 4 están hechos y desplegados** en CAMP-1. |
| `.claude/skills/crm-leads/SKILL.md` (frontend) | B | Definía `CONVERTIDO` como «lead con venta cerrada» sin matiz. Tras CAMP-1 los dos pueden divergir a propósito, y el skill habría llevado a usar `Lead.estado` como fuente de atribución. |

## Archivos eliminados

**Ninguno.** Cuatro candidatos se investigaron y los cuatro resultaron vivos:

| Candidato | Por qué NO se borra |
| --- | --- |
| `src/common/logging/request.types.ts` | No lo importa nadie porque es una **ampliación de módulo** (`declare module 'express'`). Prueba decisiva: al retirarlo, `tsc` falla en `request-id.middleware.ts:25` y `ruta-peticion.ts:23`. |
| `tools/generar-sonido-notificacion.mjs` | Cero referencias, pero **genera `public/notification.wav`**, que sí usa `notificacion-nativa.service.ts:36`. Es la procedencia reproducible de un binario versionado. |
| `scripts/seed-admin.js`, `scripts/import-pacientes.js` | Históricos y con mantenimiento pendiente (lo dice `CLAUDE.md`). Se conservan como migración reproducible. |
| `docs/auditoria-etapa2/evidencia/pantallas.json` (530 KB) | El único archivo versionado >500 KB. Es evidencia real de 10 rutas medidas, commiteada con sus scripts de reproducción. |

Las páginas `*.page.ts` del frontend y `src/main.ts` aparecieron como
«no importados» por ser **lazy** (`loadComponent`) o entrypoint. Falsos
positivos conocidos; no se tocaron.

## Contradicciones corregidas

Además de las tres de arriba, se **verificó que NO existen** las que la historia
del proyecto hacía probables:

- **Umbral CAC/ROAS**: una sola definición (`≥ 60 % de ingresos atribuibles` **Y**
  `≥ 30 ventas atribuidas`), en CAMP-0, citada sin divergir por CAMP-1 y por el
  cierre técnico. Ningún documento la contradice.
- **VPS viejo `107.172.193.34`**: aparece solo dentro de una cita explícita
  «Migrado el 2026-09-17… si encontrás documentación que hable de la máquina
  vieja, es esa». Es historia útil, no residuo.
- **`meta.target`**: las 6 apariciones dicen que **no** existe con el driver
  adapter. Correcto.
- **Marketing API**: el documento dice «no faltan scopes, falta que el token vea
  el activo». Es lo demostrado, y no se cambió.
- **CAPI**: «no hace falta para medir; sirve para optimizar». Correcto.
- **Rollback de envío**: el skill de conversaciones ya titula «y por qué **NO** se
  hace rollback (R2)».
- **View Transitions**: ningún documento pide quitarlo.
- **`firstSourceId` / `lastSourceId`**: solo se mencionan para decir que **no**
  hacen falta.

## Configuración revisada

- Los **23 scripts** de `package.json` de ambos repos apuntan a archivos que
  existen.
- Una sola configuración de Vitest (`vitest-base.config.ts`). Se sospechó que el
  builder de Angular no la cargaba —el nombre no es de autodescubrimiento— y se
  comprobó con una opción inválida: **sí se carga**, y el `isolate: true` que
  arregló la flakiness de `socket.io` está en efecto.
- `.claude/skills/angular-developer` es un **symlink** a `.agents/skills/…`, no
  una copia.
- `skills-lock.json` lo lee `tools/verificar-skills.mjs`, encadenado al build.
- **Sin flags temporales**: cero `R3_PROFILE`, `R3_INBOX` o `hrtime` en código.
  La instrumentación de R3 está retirada; solo queda su relato en `docs/`.
- **Sin residuos**: cero `console.log` y cero `TODO`/`FIXME`/`HACK` reales en
  `src/` de ambos repos (los aciertos de «TODO» son la palabra española en
  mayúsculas).

### Variables de entorno

Cruce por **nombre** entre `.env.example` y lo que el código lee de verdad
(`process.env` + `ConfigService`):

- **Las 22 documentadas se leen todas.** Ninguna variable fantasma.
- Leídas y no documentadas: `NODE_ENV` (convención de Node) y
  `DATABASE_URL_TEST`. La segunda solo la usan specs de integración y **tiene un
  valor por defecto que funciona** (`crm_test` en el :5433, ya documentado en
  `CLAUDE.md`). Es una omisión menor, no una falsedad: **no se cambió**.

## Tests

104 ficheros de prueba revisados, ninguno reescrito.

**Barrido de bombas de fecha** —la que rompió tres tests el 17/09 al cerrarse la
ventana de 24 h al día siguiente—: 26 specs usan fechas absolutas de 2026. Se
revisó, para cada uno, si su **sujeto** lee el reloj:

| Spec | Veredicto |
| --- | --- |
| `zona-clinica`, `horario-atencion`, `rango-calendario`, `politica-media-entrante`, `campana-origen`, `acuse-automatico` | Sujetos con **cero** `Date.now()`/`new Date()`: funciones puras de su fecha de entrada. Deterministas. |
| `serie-futuras` (28 fechas de octubre) | «Futuras» no es respecto a *ahora*: `dondeFuturas()` filtra por `fechaProgramada >= ` la fecha de la actividad origen. Sin fuga. |
| `primer-contacto` | El servicio expone `protected ahora(): Date` como costura y el spec la sustituye. Correcto por diseño. |
| `conversaciones.integracion` | Sus fechas absolutas son cursores de paginación, no comparaciones con ahora. |
| Todo lo que depende de la ventana de 24 h | Usa la forma relativa `new Date(Date.now() - 60_000)`. |

Búsqueda dirigida: **cero** specs siembran un `ENTRANTE` con fecha absoluta. No
quedan bombas de fecha.

### Compuertas, tras `npm ci` limpio en ambos repos

| | Backend | Frontend |
| --- | ---: | ---: |
| Unitarias | **564** (40 suites) | — |
| Integraciones (PostgreSQL real) | **510** (29 suites) | — |
| Suite | — | **357** (35 suites) |
| `build` | ✓ | ✓ |
| `test:build` | **9/9** | — |
| `check:skills` | ✓ | ✓ |
| `check:tipos` | — | ✓ |
| `git diff --check` | ✓ | ✓ |

**exit 0** y **cero unhandled errors** en ambas suites.

## Git

| | Local | `origin/main` | Producción |
| --- | --- | --- | --- |
| Backend | `db0e758` | `db0e758` | `db0e758` |
| Frontend | `6f91dc2` | `6f91dc2` | `6f91dc2` (Vercel) |

Los tres coinciden en backend; en frontend, local = origin = el `sha` que sirve
Vercel en `window.crmBuild`.

`origin/wip/2026-08-24-unidad-negocio-ventana24h` sigue siendo **rama huérfana
conocida y NO se borró**, a la espera de decisión explícita.

## CAMP-0

Cifras verificadas contra el documento, todas presentes y sin contradicción:

```
conversaciones   55 / 559        =  9,8 %
ventas            1 /  14        =  7,1 %
ingresos     Bs 400 / Bs 24.262  =  1,6 %
```

- Leads con anuncio: **288**; `source_id` distintos observados: **4**.
- Clientes con `ctwa_clid`: **116**, y los 116 tienen también `anuncioId`.
- `VentaImportada`: **2.368** filas, **2.355** con PAC, **370** cruzan con
  `Cliente.pac`, **0** útiles hoy para la cohorte de Meta.
- Líneas de WhatsApp: **1 activa** con `comercial=true` y 559 conversaciones; el
  resto sin tráfico relevante. **No se tocó configuración.**
- First touch ≈ `Lead.anuncioId`; last touch ≈ `Cliente.campanaOrigen`, que es un
  **snapshot del último referral**. No se afirma en ningún sitio que entre los
  dos compongan un modelo de atribución multicanal.

Lo corregido es el **encuadre**: esas cifras son el estado **histórico previo a
CAMP-1**, no una previsión. Reapertura para volver a medir: **4-6 semanas**
después del deploy de CAMP-1. Sin automatización y sin construir el módulo antes.

## CAMP-1

Contrato verificado en código real, punto por punto:

| Requisito | Evidencia |
| --- | --- |
| `leadId` UUID o `null` | `CorregirOrigenDto` con `@ValidateIf(o => o.leadId !== null)` + `@IsUUID()` |
| Cuerpo vacío → 400 | Ausente ≠ `null`: `@ValidateIf` deja correr `@IsUUID()` sobre `undefined` |
| Lead del mismo cliente | `lead.clienteId !== venta.clienteId` → `BadRequestException` |
| Inexistente y ajeno indistinguibles | Mismo mensaje en ambos caminos |
| `alcanceAgente` | El controller lo pasa; venta ajena → **404**, no 403 |
| No modifica importe ni estado | El `update` escribe `data: { leadId }` y nada más |
| No ejecuta `marcarConvertidos` | **0 ocurrencias** dentro de `corregirOrigen` |
| Audita `CAMBIO_ORIGEN` al cambiar | `audit.registrar('Venta', id, 'CAMBIO_ORIGEN', …)` |
| No audita X → X | Corto-circuito `if (venta.leadId === dto.leadId)` |
| `GET /ventas` expone `lead{id,origen,anuncioId}` | En los 4 puntos de lectura del service |

Frontend: `origenInequivoco()` es literalmente
`leads.length === 1 ? leads[0].id : null` — 1 lead preselecciona, 0 y 2+ devuelven
`null`—, y la selección manual nunca se sobrescribe (`origenElegidoAMano`).
Navegación SPA intacta: `view-transition-name` en topbar y sidebar, transición
acotada al contenido, `prefers-reduced-motion` explícito, y el scroll de
`.workspace` vuelve arriba solo al cambiar de *path*, no de query param.

Cobertura de pruebas, sin añadir ninguna por inflar el número:

- Backend (13 + 5 de DTO): lead correcto, reemplazo, `null`, lead de otro
  cliente, venta inexistente, alcance por agente, ADMIN sin alcance, no crea otra
  venta, importe/estado/agente/comprobante intactos, `Venta → Lead → anuncioId`,
  el embudo no se reescribe, bitácora escrita, y X→X sin entrada.
- Frontend (5 + 5 de la regla): lead existente a la vista, cambiarlo, quitarlo,
  varios leads sin elección silenciosa, y el error del backend que **no** deja la
  interfaz fingiendo que guardó.

**`marcarConvertidos` sigue con sus dos ramas**, sin cambios: con `leadId` cierra
ese lead; sin `leadId` cierra todos los abiertos del cliente. Antes de CAMP-1
solo corría la ancha, porque `leadId` era siempre `NULL`.

**Backfill de las 14 ventas históricas: NO ejecutado**, y sigue documentado en
`CAMP-1-atribucion-venta-lead.md` con su `UPDATE` y su razón — haría el grafo
consistente sin mover la cobertura de ingresos.

## Deuda que permanece

Cinco, todas reverificadas en esta revisión. Están en
[`CIERRE-TECNICO-2026-09.md`](CIERRE-TECNICO-2026-09.md) con su detalle:

1. `take: 1` no se traduce a `LIMIT` (`conversaciones.service.ts:222`).
2. Preflight por conversación, sin waterfall real de navegador que lo mida.
3. MIME de la media saliente por extensión
   (`despachador-saliente.service.ts:175`), no por `mediaMime`.
4. `x-force-reload` es palanca muerta: `token.interceptor.ts:45` la lee y el
   backend no la emite nunca.
5. `Lead.estado` no se reconcilia al corregir `Venta.leadId`.

**Dejó de ser deuda:** «la PWA no se auto-recarga». No automatizarlo es una
decisión con motivo escrito —no hay forma de distinguir un momento seguro—, no un
pendiente.
