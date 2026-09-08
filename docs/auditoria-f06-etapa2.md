# Informe de Auditoría y Benchmark — Etapa 2 (Inbox, Sesión y PWA)

> Evidencia histórica del 7 de septiembre de 2026; no es un handoff ni una
> fase completada. El estado y la siguiente tarea están en
> [ESTADO_ACTUAL.md](ESTADO_ACTUAL.md). Los scripts conservados contienen rutas
> de macOS y herramientas externas: no son verificaciones portables del proyecto.

## Diagnóstico histórico

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
   - La búsqueda de pacientes en el listado toma ~819 ms en aquella medición local. Ese tiempo no demuestra por sí solo su causa ni representa Linux o producción.
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
- `backend-crm-montalvo/docs/auditoria-etapa2/` (scripts históricos `.cjs` y `.py`; adaptar antes de reutilizar)

---

Las propuestas de corrección no se implementaron en esta etapa. Consultar el
handoff antes de iniciar otra fase; conservar estas evidencias como baseline.
