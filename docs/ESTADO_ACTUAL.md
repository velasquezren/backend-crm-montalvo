# Estado actual

**Actualizado: 7 de septiembre de 2026.**

Este es el punto de entrada, y el **único** documento de estado. Se trabaja desde
dos máquinas y se cambia de sesión a menudo: antes de tocar nada, leerlo y hacer
`git fetch` en los dos repos. Actualizarlo es parte de cerrar cada fase, no un
extra — si se atrasa, vuelve el problema que vino a resolver.

## Repositorios

Dos repos **independientes** bajo un mismo directorio padre. Sin monorepo, sin
submódulos, sin worktrees extra. **El directorio padre no es un repositorio
git**: nada que viva solo ahí sobrevive a un cambio de máquina.

| Repo | Rama | Remoto |
| --- | --- | --- |
| `backend-crm-montalvo` | `main` | `github.com/velasquezren/backend-crm-montalvo` |
| `frontend-crm-montalvo` | `main` | `github.com/velasquezren/frontend-crm-montalvo` |

Node **>= 22** en ambos (`engines`). Instalar siempre con `npm ci`, nunca
`npm install`: el lockfile es la fuente de verdad.

## Fases

El plan completo está en [`auditoria-arquitectonica-2026-09-05.md`](auditoria-arquitectonica-2026-09-05.md);
§19 tiene las diez fases. Su veredicto de fondo: **no se reescribe nada**. Se
conservan el monolito Nest, Prisma directo y Angular por funcionalidades. La
deuda está en las fronteras —autorización, atomicidad, trabajos asíncronos y
sincronización de UI—, no en la forma del código. No introducir Clean
Architecture, Repository Pattern ni capas nuevas para resolver un punto del plan.

| Fase | Estado | Dónde quedó |
| --- | --- | --- |
| F01 · build sin entrypoint | **Cerrada** | `428cb3f` + `scripts/verificar-build.mjs` |
| F02 · importación atómica | **Cerrada** | `775abbd`, [`auditoria-f02.md`](auditoria-f02.md) |
| F03 · consistencia del periodo | **Cerrada** | `775abbd`, [`auditoria-f03.md`](auditoria-f03.md) |
| F04 · autorización por operación | **Cerrada** | `775abbd`, [`auditoria-f04.md`](auditoria-f04.md) |
| F05 · contrato de sesión | **Cerrada en código · SIN DESPLEGAR** | `775abbd` + frontend `9aa073a`, [`auditoria-f05.md`](auditoria-f05.md) |
| F06 · rechazos fuera de la petición | **Entrega 1 cerrada · entrega 2 sin empezar** | `58bae3a`, [`auditoria-f06.md`](auditoria-f06.md) |
| F07 · estado remoto Angular | Diagnóstico hecho, sin corregir | [`auditoria-f06-etapa2.md`](auditoria-f06-etapa2.md) |
| F08 · consultas cortadas | Sin empezar | §19 del informe |
| F09 · dos PWA en el mismo scope | Diagnóstico hecho, sin corregir | [`auditoria-f06-etapa2.md`](auditoria-f06-etapa2.md) |
| F10 · calendario e historiales | Sin empezar | §19 del informe |

**Ojo con la numeración.** El archivo `auditoria-f06-etapa2.md` se tituló F06
pero cubre F07 y F09 —carrera del inbox, sesión cruzada y colisión de Service
Workers—. Manda la numeración del informe maestro, que es la de esta tabla. El
nombre del archivo se conserva para no romper los commits que ya lo citan.

## Segunda auditoría (Performance / UX Premium)

**EN ANÁLISIS — no iniciada como implementación.** No hay una sola línea de
código suya en `main`.

Lo que existe es diagnóstico reproducido: los scripts de Playwright en
`docs/auditoria-etapa2/` y 67 archivos de evidencia (capturas a 1440/1024/390 y
JSON de mediciones) en `docs/auditoria-etapa2/evidencia/`. Midieron la búsqueda
de pacientes en ~819 ms, tres peticiones repetidas por cambio de chat, y el
exceso de alto en Actividades a 390 px.

**Esos scripts no corren fuera de la máquina que los escribió**: llevan cableadas
rutas de macOS (`/Users/macmini2024/…`) al binario de Playwright, a su carpeta de
salida y a una base `crm_audit`. Sirven como evidencia y como referencia de
método; para volver a ejecutarlos hay que parametrizarlos primero. No se hizo
aquí a propósito: es trabajo de esa auditoría, no del saneamiento.

## Lo primero que hay que saber

**La migración de F05 no está aplicada en producción.** Es
`20260907180000_sesion_revocable`, aditiva: `Usuario.versionSesion` con default 0
más la tabla `SesionUsuario`. Hay que aplicarla **antes** de subir la aplicación
nueva, o el backend arranca contra un esquema sin esas columnas. Al desplegar,
los tokens vigentes dejan de servir: todo el mundo vuelve a entrar.

**Las suites que verifican comisiones contra los Excel reales se omiten si no
están los archivos.** Salen en verde igual — ahora al menos avisan por consola.
`verificacion-diciembre.integracion.spec.ts` es la única prueba que compara el
motor contra lo que administración pagó de verdad en diciembre de 2025, así que
antes de tocar comisiones conviene definir `CRM_EXCELS_2025_DIR` y
`CRM_EXCELS_2026_DIR` (ver `.env.example`). Los `.xlsx` **no se versionan**:
llevan nombres de pacientes y las cifras pagadas.

## No tocar

Decisiones que la auditoría verificó y que no deben deshacerse sin leer su
informe primero:

- **La arquitectura se conserva.** Ver §21 del informe maestro.
- **`pg_try_advisory_xact_lock` + `RepeatableRead`** en los comandos de periodo
  (F03). Sin eso, pagar y reabrir concurrentes se pisan y gana el último.
- **La publicación atómica de la planilla** (F02): preparar fuera, publicar
  dentro. Revertirlo devuelve la pérdida del periodo anterior ante un fallo de
  lote.
- **La sesión revocable** (F05): el token lleva `type`, `sid` y `versionSesion`,
  y HTTP y socket los comprueban contra la base.
- **`enSegundoPlano`** (F06) en todo disparo sin `await`. `check:skills` lo
  exige; quitarlo devuelve el bucle de reinicios de systemd.
- **El tipo de cambio en modo FIJO manda sobre la serie diaria.** La clínica
  opera a 6,97 pactado; el oficial se despegó a 11,92 y convertía toda la app un
  71 % por encima de lo realmente pagado.
- **Prisma 7 con adaptador `pg`**, no el motor Rust. No subir a la 8 mientras
  `latest` sea un release candidate.

## Cómo continuar

Hay dos frentes abiertos e independientes. **El siguiente es F06 entrega 2**, que
cierra la fase empezada:

1. **F06 entrega 2 — durabilidad.** La entrega 1 solo evita que un fallo en
   segundo plano tumbe el proceso; el trabajo se pierde igual y no se reintenta
   nada. Falta recepción y despacho persistentes: estado en base, reintento
   controlado e idempotencia. Lo delicado es distinguir "no se envió" de "no sé
   si se envió": un reintento ciego tras un corte entre Meta y la anotación
   manda el mensaje dos veces a la paciente. Tests que pide el plan: caída de
   Prisma, reinicio entre guardar y enviar, resultado externo desconocido,
   idempotencia.
2. **F07 y F09 — frontend.** Ya diagnosticados: descarte por ID de conversación
   en `conversaciones-state.service.ts`, reset de los stores al hacer `logout()`,
   y un solo Service Worker (`ngsw-worker.js` y `sw.js` compiten por el scope
   raíz).

**No iniciar la auditoría de Performance/UX Premium hasta cerrar F06 entrega 2.**

## Cómo se cierra una fase

Del informe, §19: pruebas relevantes antes, una sola preocupación por entrega,
pruebas después, typecheck, build, revisión del diff y comprobación de
comportamiento. Cada entrega se despliega por separado y lleva su informe
`auditoria-fNN.md` con la reproducción previa y el rollback. Cuando se corrige un
bug se documenta el cambio deliberado; cuando se extrae código se exige
equivalencia. No borrar un camino anterior sin probar que ya nadie lo usa.

Verificar contra datos reales, no solo compilar: varias veces un cambio pasó las
pruebas y falló contra los 1.287 servicios o el Excel de diciembre.

## Verificaciones antes de trabajar

```bash
# backend
npm ci
npm run build     # check:skills + nest build + check:build
npm test          # unitarias

# integración: necesita PostgreSQL en :5433. Si no hay uno, la receta del
# Postgres descartable está en .claude/skills/crm-backend-arquitectura §8
npm run test:integracion:preparar && npm run test:integracion

# frontend
npm ci
npm run build     # check:tipos + check:skills + ng build
npm test
```

## Deuda conocida, sin abrir

Hallazgos anotados durante el saneamiento del 7 de septiembre. **Ninguno se
arregló**: no pertenecen a esta fase.

| Qué | Dónde | A qué fase pertenece |
| --- | --- | --- |
| Los scripts de la etapa 2 tienen rutas de macOS cableadas y no corren en otra máquina | `docs/auditoria-etapa2/*.cjs`, `*.py` | Auditoría Performance/UX, antes de reutilizarlos |
| `auditoria-f04.md` y `auditoria-f05.md` citan parches y logs en `/tmp` que ya no existen | esos dos informes | Ninguna: son históricos, corregidos con una nota |
| `GEMINI.md` repite buena parte de `CLAUDE.md` y de los skills, y nada lo verifica — ya se le encontró un dato contradictorio con el código | `GEMINI.md` | Candidato a consolidar en la próxima pasada de documentación |
| Los scripts de la etapa 2 llevan una contraseña sintética de usuario sembrado (`AuditoriaLocal2026!`) y un JWT_SECRET de prueba | `docs/auditoria-etapa2/crm-etapa2-seed.cjs`, `crm-etapa2-local.py` | No es un secreto de producción; rotar si el repo se hace público |
