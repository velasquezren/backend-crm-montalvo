# Guía común para asistentes de IA — backend

Esta guía sirve como punto de entrada para Claude, Codex, Gemini, Copilot, Cursor,
Antigravity y asistentes que pueden leer archivos del repositorio. Las reglas del
CRM no dependen del proveedor del modelo.

## Al comenzar una tarea

1. Lee `CLAUDE.md`: contiene las reglas operativas, seguridad, comandos y trampas
   reales del backend.
2. Lee `docs/PANORAMA.md` y `docs/ESTADO_ACTUAL.md` para conocer el sistema y el
   trabajo vigente. El segundo documento es el único handoff de fases.
3. Lee `../frontend-crm-montalvo/CRM_MANIFESTO.md`, que gobierna ambos repos.
4. Consulta los archivos `.claude/skills/*/SKILL.md` pertinentes a tu cambio.
   Si tu herramienta no carga skills automáticamente, léelos como documentos.
5. Comprueba `git status` y el historial remoto antes de editar. Los dos repos
   viven juntos y se actualizan desde más de una máquina.

## Reglas compartidas

- Backend: NestJS, Prisma y PostgreSQL. El servidor es la autoridad de permisos,
  datos y validación. Respeta los límites de dominio descritos en `CLAUDE.md`.
- No hay staging y el CRM atiende pacientes reales. Evita cambios especulativos
  y despliegues sin seguir la guía del backend.
- `npm run build` es la comprobación oficial del backend. Las pruebas unitarias e
  integración se ejecutan según el cambio y las instrucciones de `CLAUDE.md`.
- `CRM_MANIFESTO.md`, `docs/ESTADO_ACTUAL.md`, los contratos del código y las
  comprobaciones automáticas son la referencia. Si una guía contradice el código,
  actualiza la guía en el mismo cambio cuando corresponda.
- Nunca copies credenciales o datos reales de pacientes en prompts, ejemplos,
  logs o archivos versionados.

## Puntos de entrada por herramienta

- Claude Code: `CLAUDE.md` y `.claude/skills/`.
- Gemini CLI: `GEMINI.md`.
- Codex y agentes que admiten instrucciones de repositorio: `AGENTS.md`.
- GitHub Copilot: `.github/copilot-instructions.md`.
- Cursor: `.cursor/rules/crm.mdc`.
- Cualquier otro asistente: pídele que lea este archivo y `AGENTS.md` antes de
  trabajar. Si admite instrucciones persistentes, configura `AI_GUIDE.md` como
  contexto del proyecto.

Las skills bajo `.claude/skills/` son Markdown normal y sus reglas se pueden
seguir con cualquier modelo; solo su carga automática depende de la herramienta.

## VPS

En esta estación SSH tiene el alias local `montalvo-vps`. La IA puede usarlo
para las tareas remotas que el usuario solicite; no guardes ni muestres
contraseñas, claves privadas, `.env` ni datos de pacientes. Ese VPS es
producción, no staging: desarrolla en el repositorio local y sigue el
procedimiento documentado para desplegar. No modifiques archivos desplegados,
reinicies servicios, ejecutes migraciones ni borres datos sin una petición
explícita para esa acción.

La conexión no interactiva de la IA todavía puede requerir que se autorice la
clave pública en el VPS. Si SSH responde `Permission denied`, informa del fallo;
no pidas ni guardes la contraseña en un prompt o archivo.
