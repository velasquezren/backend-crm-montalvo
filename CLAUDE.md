# CRM Clínica Montalvo — backend

NestJS + Prisma + PostgreSQL; frontend Angular en el repo hermano.
Esta es la entrada operativa común para Claude Code y los demás agentes.

## Orientación y fuentes

1. Comprueba `git status` y el historial; haz `git fetch` en los repos implicados
   antes de editar. Conserva trabajo local ajeno; no sincronices con reset.
2. Lee el [estado breve](docs/ESTADO_ACTUAL.md) y usa el [índice por tarea](docs/README.md) para elegir
   la sección necesaria. No cargues todas las auditorías ni todas las skills.
3. Busca primero la implementación y sus tests (`rg` y `git log --all -- <ruta>`).
   Un «pendiente» histórico no demuestra que falte la funcionalidad.

La petición actual fija el alcance. El contrato ejecutable (código, schema,
migraciones y tests) describe lo implementado; el [manifiesto](../frontend-crm-montalvo/CRM_MANIFESTO.md) fija
los principios de arquitectura y marca. Las guías y skills explican decisiones.
Si discrepan, contrasta la evidencia: no cambies comportamiento solo para hacer
coincidir una frase, ni declares correcto un bug porque compila.
`check:skills` valida comprobaciones concretas, no toda la prosa ni producción.

## Límites operativos

- No hay staging; producción atiende pacientes reales. No desplegar, reiniciar,
  migrar, enviar mensajes ni cambiar Meta/VPS sin una petición que lo autorice.
  Un push a `main` del frontend publica en Vercel; el del backend no despliega.
- No copiar secretos, `.env` ni datos reales de pacientes a documentación,
  prompts, ejemplos o logs. El alias SSH local `montalvo-vps` no identifica por
  sí solo el servidor del CRM: distinguir CRM/Resultados de agenda ScriptCase.
- No usar navegador en este proyecto; comprobar UI desde código y declarar el
  límite. Para API, pruebas locales o `curl` contra desarrollo.
- Actualizar la guía propietaria cuando cambie un contrato. El historial no es
  una lista de órdenes; no crear un archivo de seguimiento por sesión.

## Reglas de implementación

- Cada módulo escribe sus tablas; pide mutaciones al service dueño. Lecturas
  agregadas entre dominios permitidas. Excepciones en [PANORAMA](docs/PANORAMA.md#quién-escribe-cada-tabla).
- Reutilizar helpers de roles, paginación, caché y trabajo en segundo plano.
  No comparar roles a mano, añadir `any`, ni mezclar permiso con filtro de vista.
- DTO con `class-validator`; webhooks Meta firmados; cambios de schema con
  migración revisada. Tipos Prisma desde `src/prisma/prisma-client.ts`.
- Antes de cambiar código, consultar **Reglas de oro** y las secciones del área
  en [crm-backend-module](.claude/skills/crm-backend-module/SKILL.md).
  Infraestructura/despliegue/rendimiento: solo la sección correspondiente de
  [crm-backend-arquitectura](.claude/skills/crm-backend-arquitectura/SKILL.md).
  No necesita leer esta última quien solo modifica documentación o un DTO.

## Comprobación

Instalación y comandos: [README](README.md). Para código, `npm run build` es
la compuerta oficial, más tests del comportamiento afectado; integración real
si cambia persistencia, permisos o concurrencia. Para documentación, ejecutar
`check:skills` en ambos repos si cambian sus contratos, comprobar enlaces y
`git diff --check`; no repetir toda la suite de negocio por cambios de prosa.
`test:integracion:preparar` **borra crm_test**: solo en PostgreSQL descartable propio.

## Skills de terceros

`prisma-client-api` y `supabase-postgres-best-practices` son referencias opcionales
copiadas de sus proveedores; no editarlas como reglas locales. Aquí no hay RLS,
las tablas Prisma conservan mayúsculas y los tipos salen del barril local.
Sus consejos no autorizan `db push`, `migrate reset` ni cambios de arquitectura.
