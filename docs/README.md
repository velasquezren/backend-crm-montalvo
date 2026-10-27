# Encontrar contexto del CRM

Este índice sirve a **backend y frontend**. No es otra especificación: elija la
fila de su tarea, localice el código y lea solo la sección relevante de la guía.
Para trabajar: [CLAUDE.md](../CLAUDE.md). Para retomar: [estado breve](ESTADO_ACTUAL.md).

## Fuentes y responsabilidades

| Información | Fuente |
| --- | --- |
| Alcance y autorización | Petición actual; una tarea antigua no autoriza operaciones nuevas |
| Reglas permanentes de trabajo | `CLAUDE.md` de cada repo; los otros archivos de entrada solo apuntan a él |
| Arquitectura y marca | [CRM_MANIFESTO](../../frontend-crm-montalvo/CRM_MANIFESTO.md) |
| Comportamiento implementado | Código, DTO, schema/migraciones y pruebas; el test también puede estar incompleto |
| Responsabilidad de módulos y cruces permitidos | [PANORAMA](PANORAMA.md); dependencias efectivas en `*.module.ts` y llamadas de services |
| Cómo implementar y por qué | Skill o guía del dominio, elegida abajo |
| Instalación y verificaciones | [README backend](../README.md), [README frontend](../../frontend-crm-montalvo/README.md), scripts npm y workflows |
| Pendientes y continuidad | [ESTADO_ACTUAL](ESTADO_ACTUAL.md), con evidencia y límite de comprobación |
| Lo que pasó y cómo se validó | Git, auditoría fechada y [historial](#historial-y-planes); no instrucciones vigentes |
| Producción, tarifas y proveedores | Comprobación autorizada en el entorno correspondiente; `.env.example` describe variables, no sus valores reales |

## Elegir por tarea

Las rutas de código backend parten de `src/`; las frontend, de
`../frontend-crm-montalvo/src/app/`. Las pruebas están junto al código. Para
buscar casos use `rg --files <carpeta> -g '*.spec.ts'`; no copie conteos de una
auditoría como resultado de una prueba nueva.

| Tarea | Guía que conviene abrir | Entrada de código y dependencia clave |
| --- | --- | --- |
| Orientación general | [PANORAMA](PANORAMA.md) | `app.module.ts`; frontend `app.routes.ts` |
| API, DTO, roles, transacciones | [crm-backend-module](../.claude/skills/crm-backend-module/SKILL.md), reglas de oro + sección afectada | `modules/<dominio>`, `common/auth/roles.ts`, `common/guards/`; schema y migraciones |
| Página, carga de datos, modal, sesión | [crm-feature-page](../../frontend-crm-montalvo/.claude/skills/crm-feature-page/SKILL.md) | Frontend `features/<dominio>`, `core/api`, `core/auth`; controller/DTO backend |
| HTML/CSS, controles y accesibilidad | [crm-design-system](../../frontend-crm-montalvo/.claude/skills/crm-design-system/SKILL.md), [revisión desde código](../../frontend-crm-montalvo/.claude/skills/crm-ui-desde-codigo/SKILL.md) | Frontend `shared/components`; `src/styles.css`. Buscar el componente antes de crearlo |
| Chat, envío, media, realtime | [crm-conversaciones](../../frontend-crm-montalvo/.claude/skills/crm-conversaciones/SKILL.md), [líneas](lineas-whatsapp.md) | `modules/conversaciones`; ingesta, despachador y gateway; frontend `features/conversaciones` |
| Atención y menús | [Atención humana](atencion-humana.md), [menú](menu-atencion.md), [separación comercial](recepcion-y-ventas.md) | `atencion-humana.ts`, `ingesta-whatsapp.service.ts`, `modules/menu-atencion`; no otro asignador |
| IA, audio y herramientas | [Asistente](asistente-ia.md), sección del caso | `modules/asistente` (modelo/herramientas) + `conversaciones/asistente-chat.service.ts` (efectos); tests del bucle y `asistente-chat.integracion.spec.ts` |
| Agenda, médico, cupos y reservas | [Agenda](agenda.md), [QR/comprobante](reservas-pago-chat.md), [avisos a caja](avisos-caja.md) | `modules/agenda`; `AgendaReservasService` compartido por web, Flow e IA; `ReservaChat` en Conversaciones |
| Horarios FileMaker | [Contrato y aceptación](filemaker-horarios.md) | `agenda/horario-filemaker*`, `DirectorioService`; frontend ficha médica. PostgreSQL guarda revisión, MySQL cupos |
| Promociones, cobros, ficha web | [Promociones/directorio](promociones-y-directorio.md), [pagos](pagos-promocion.md) | `modules/promociones`, `directorio`, `cobros`; Conversaciones orquesta tarjetas/pagos; landing consume API pública |
| Informes de Resultados | [Mis informes](informes-por-whatsapp.md) | `modules/resultados`; portal independiente. Entrega con autorización fuera del modelo |
| Actividades y campanita | [Reservas/actividades](reservas-actividades.md), [manual de uso](../../frontend-crm-montalvo/docs/MANUAL_USUARIO.md) | `modules/actividades`; consulta agenda/chat para seguimiento, no escribe la cita clínica |
| Pacientes, leads, ventas y campañas | [crm-leads](../../frontend-crm-montalvo/.claude/skills/crm-leads/SKILL.md), [CAMP-1](CAMP-1-atribucion-venta-lead.md), [aviso de ventas a Meta](conversiones-meta.md) | `modules/clientes`, `leads`, `ventas`, `campanas`, `kpis`, `conversiones-meta`; atribución por `Venta.leadId` |
| Comisiones y finanzas | [Manual contractual](../MANUAL-COMISIONES.md), [crm-finanzas](../../frontend-crm-montalvo/.claude/skills/crm-finanzas/SKILL.md) | `modules/planilla-comisiones`, `tipo-cambio`; hub frontend `finanzas`. No confundir ventas CRM con Excel de liquidación |
| Instalación, build o despliegue | README del repo; [arquitectura §4 y §8](../.claude/skills/crm-backend-arquitectura/SKILL.md) según la tarea | `package.json`, workflows, `prisma.config.ts`; despliegue exige autorización y respaldo |
| Salud y errores HTTP | README y arquitectura §4; contratos junto al código | `common/health`, `common/logging`, `common/filters`, `common/errores` (Sentry/GlitchTip). Seguir `requestId`; no registrar cuerpos ni datos de pacientes |
| Barridos periódicos | [arquitectura §5](../.claude/skills/crm-backend-arquitectura/SKILL.md#5-decisiones-de-arquitectura-ya-tomadas--no-las-reabras-sin-el-porqué) («Tareas periódicas») | `common/trabajos`: `@TareaPeriodica` y pg-boss (`TRABAJOS_PGBOSS`); las colas durables propias siguen en su módulo |
| Rendimiento | [crm-rendimiento](../../frontend-crm-montalvo/.claude/skills/crm-rendimiento/SKILL.md), arquitectura §7 | Medir el recorrido afectado antes/después. R3 es evidencia de septiembre, no medición actual |
| Meta y Flows | [Integración Meta](../../frontend-crm-montalvo/META_INTEGRATION_GUIDE.md), [procedimiento de Flows](whatsapp-interacciones/flows/PRUEBA-REAL.md) | `common/whatsapp`, webhooks, `agenda-flow*`; manifiestos JSON y validadores locales |

Las skills locales largas conservan patrones y regresiones que no conviene
borrar. Para localizar una sección sin cargarlas enteras:

```bash
rg -n '^#{1,3} ' .claude/skills/crm-backend-module/SKILL.md
rg -n 'simbolo_o_ruta' src docs .claude/skills
git log --all --oneline -- src/modules/dominio
```

No abrir los dos README de instalación para una tarea que no prepara el entorno,
ni finanzas para corregir el chat. Las referencias genéricas de Angular/Prisma
se consultan cuando hace falta una API; no son lectura inicial.

## Historial y planes

Antes de retomar un hallazgo, buscarlo en **Trabajo cerrado** del estado breve,
sus tests y Git. Mantener pruebas, SQL y procedimientos de rollback asociados.

- [Historial septiembre](historial/estado-2026-09.md) y
  [octubre](historial/estado-2026-10.md): entradas originales del antiguo estado,
  incluidas evidencias de despliegue. No ejecutar sus instrucciones por fecha.
- `auditoria-f*.md`, [auditoría arquitectónica](auditoria-arquitectonica-2026-09-05.md),
  [cierre técnico](CIERRE-TECNICO-2026-09.md), [revisión final](REVISION-FINAL-ARCHIVOS-2026-09.md)
  y [R3](rendimiento-r3-2026-09.md): diagnósticos y resoluciones de septiembre.
- [CAMP-0](CAMP-0-campanas-meta-roi.md): diagnóstico de atribución y opciones;
  [CAMP-1](CAMP-1-atribucion-venta-lead.md) es el contrato implementado.
- Entregas del 21/09: [WhatsApp, agenda y modales](ENTREGA_WHATSAPP_AGENDA_MODALES_2026-09-21.md)
  y [Recepción compartida](recepcion-atencion-compartida-2026-09-21.md); F06-R2 en
  [primer contacto durable](f06-r2-primer-contacto-durable.md). Evidencia cruda de
  la etapa 2 en `auditoria-etapa2/` (scripts locales; no ejecutar).
- [Auditoría 1/10](auditoria-2026-10-01.md), [6/10](auditoria-2026-10-06.md) y
  [revisión 10/10](REVISION_2026-10-10.md): evidencia fechada, no backlog automático.
- Auditorías de agenda [VPS](auditoria-agenda-vps-2026-10-06.md) y
  [SQL](auditoria-agenda-sql-2026-10-06.md): procedencia del contrato ScriptCase;
  [agenda](agenda.md) describe la integración posterior.
- [Preparación IA](ia-herramientas.md) e interacciones
  [fase 1](whatsapp-interacciones/README.md)/[fase 2](whatsapp-interacciones/FASE-2.md):
  antecedentes superados por la implementación, conservados por sus decisiones.
- [Auditoría de contexto del 15/10](auditoria-contexto-2026-10-15.md): evidencia y
  límites de esta reorganización; no nueva lista de trabajo funcional.

No se necesita un nuevo archivo de seguimiento por sesión. Cambiar el contrato
en su guía propietaria, el pendiente en el estado breve y el detalle en Git.
