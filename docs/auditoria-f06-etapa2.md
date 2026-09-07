# Informe de Auditoría y Benchmark — Etapa 2 (Inbox, Sesión y PWA)

## Resumen Ejecutivo del Estado al Cierre de Sesión

Durante esta sesión de auditoría local en profundidad (previo a modificaciones de código de la segunda etapa), se reprodujeron y documentaron con pruebas automatizadas tres problemas críticos de estabilidad y consistencia:

1. **Condición de Carrera en el Inbox (Mezcla de Chats):**
   - Cuando ocurren respuestas tardías de red al alternar entre conversaciones, las cargas diferidas de un chat previo pueden sobrescribir o intercalarse con el chat actualmente activo.
   - Si el usuario conmuta rápidamente entre conversaciones, las peticiones en vuelo no se cancelan ni se descartan adecuadamente por ID de conversación activa.

2. **Fuga / Conservación de Estado entre Sesiones (Sesión Cruzada):**
   - Al cerrar sesión o cambiar de usuario (por ejemplo, de administrador a agente o viceversa), el estado reactivo de conversaciones en memoria del frontend no se reinicia por completo.
   - Esto permite que fragmentos de conversaciones previas sigan visibles temporalmente en la vista antes de reautenticar.

3. **Conflicto y Competencia de Service Workers (PWA):**
   - Se confirmó una colisión entre el Service Worker de Angular PWA (`ngsw-worker.js`) y el Service Worker de notificaciones nativas push (`sw.js`).
   - Ambos compiten por el scope raíz o interceptación de eventos de ciclo de vida, lo cual genera recargas o desincronización de caché.

4. **Rendimiento y Tiempos de Respuesta Local:**
   - La búsqueda de pacientes en el listado toma ~819 ms debido a reactividad/renderizado no optimizado en el listado y debounce.
   - El cambio de chat repite tres peticiones de red incluso entre conversaciones que ya habían sido abiertas en la misma sesión.
   - En vistas móviles (390px), la sección de Actividades consume excesivo espacio superior con filtros y resúmenes antes de desplegar la primera tarea.

---

## Archivos y Evidencia Guardada

Toda la evidencia gráfica (capturas en resoluciones 1440, 1024 y 390), trazas de telemetría de rendimiento y scripts ejecutables de reproducción fueron respaldados en:
- `backend-crm-montalvo/docs/auditoria-etapa2/evidencia/`
  - `benchmarks.json` (métricas de tiempos de DOM, layout y tareas)
  - `inbox-pruebas.json` (reproducción de carreras de historial y alternancia de chats)
  - `sesion-cruzada.json` y `sesion-cruzada.png` (evidencia de estado remanente)
  - `pwa.json` (colisión de workers)
  - Capturas responsive: `actividades-*.png`, `conversaciones-*.png`, `dashboard-*.png`, `chat-mobile-390.png`, etc.
- `backend-crm-montalvo/docs/auditoria-etapa2/` (scripts `.cjs` y `.py` de prueba reproducibles)

---

## Próximos Pasos para la Siguiente Sesión

1. **Frontend Inbox:**
   - Implementar control de secuencia / token de cancelación (o `switchMap` / ID guard) en `conversaciones-state.service.ts` para que respuestas tardías de chats anteriores se descarten.
   - Cachear conversaciones ya abiertas para evitar las 3 peticiones redundantes por cambio de chat.
2. **Frontend Auth / Sesión:**
   - Ejecutar un reset total explícito de los stores y estados en memoria (`conversacionesState.limpiar()`, etc.) al emitir `logout()` o detectar cambio de token.
3. **PWA / Service Worker:**
   - Unificar la gestión del worker de notificaciones con el PWA worker o delimitar sus ámbitos y eventos para evitar colisión de registro.
4. **UX Móvil:**
   - Compactar filtros y resúmenes superiores en móvil para visibilizar tareas de inmediato.
