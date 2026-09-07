# Estado del plan de refactorización

**Este archivo es el punto de entrada.** Se trabaja desde dos máquinas y se
cambia de sesión a menudo; antes de tocar nada, leerlo y hacer `git fetch` en
los dos repos. Actualizarlo es parte de cerrar cada fase, no un extra.

El plan completo está en [`auditoria-arquitectonica-2026-09-05.md`](auditoria-arquitectonica-2026-09-05.md)
(§19 tiene las diez fases). Su veredicto de fondo: **no se reescribe nada**. Se
conservan el monolito Nest, Prisma directo y Angular por funcionalidades. La
deuda está en las fronteras —autorización, atomicidad, trabajos asíncronos y
sincronización de UI—, no en la forma del código. No introducir Clean
Architecture, Repository Pattern ni capas nuevas para resolver un punto del plan.

## Dónde vamos

| Fase | Estado | Dónde quedó |
| --- | --- | --- |
| F01 · build sin entrypoint | **Cerrada** | `428cb3f` + `scripts/verificar-build.mjs` |
| F02 · importación atómica | **Cerrada** | `775abbd`, [`auditoria-f02.md`](auditoria-f02.md) |
| F03 · consistencia del periodo | **Cerrada** | `775abbd`, [`auditoria-f03.md`](auditoria-f03.md) |
| F04 · autorización por operación | **Cerrada** | `775abbd`, [`auditoria-f04.md`](auditoria-f04.md) |
| F05 · contrato de sesión | **Cerrada en código, SIN DESPLEGAR** | `775abbd` + frontend `9aa073a`, [`auditoria-f05.md`](auditoria-f05.md) |
| F06 · inbox, sesión cruzada y PWA | **Diagnóstico hecho, sin corregir** | [`auditoria-f06-etapa2.md`](auditoria-f06-etapa2.md) |
| F07–F10 | Sin empezar | §19 del informe |

## Lo primero que hay que saber

**La migración de F05 no está aplicada en producción.** Es
`20260907180000_sesion_revocable`, aditiva: `Usuario.versionSesion` con default 0
más la tabla `SesionUsuario`. Hay que aplicarla **antes** de subir la aplicación
nueva, o el backend arranca contra un esquema que no tiene esas columnas. Al
desplegar, los tokens vigentes dejan de servir: todo el mundo vuelve a entrar.

## Lo siguiente, si nadie dijo otra cosa

F06, que ya tiene el diagnóstico reproducido con scripts en
`docs/auditoria-etapa2/` y evidencia en `docs/auditoria-etapa2/evidencia/`:

1. Descarte por ID de conversación en `conversaciones-state.service.ts`, para que
   una respuesta tardía no se mezcle con el chat abierto.
2. Reset explícito de los stores en memoria al hacer `logout()`.
3. Un solo Service Worker: hoy `ngsw-worker.js` y `sw.js` compiten por el scope raíz.
4. Móvil: Actividades gasta demasiado alto antes de la primera tarea.

## Cómo se cierra una fase

Del informe, §19: pruebas relevantes antes, una sola preocupación por entrega,
pruebas después, typecheck, build, revisión del diff y comprobación de
comportamiento. Cada entrega se despliega por separado y lleva su informe
`auditoria-fNN.md` con la reproducción previa y el rollback. Cuando se corrige un
bug se documenta el cambio deliberado; cuando se extrae código se exige
equivalencia. No borrar un camino anterior sin probar que ya nadie lo usa.

Verificar contra datos reales, no solo compilar: varias veces un cambio pasó las
pruebas y falló contra los 1.287 servicios o el Excel de diciembre.
