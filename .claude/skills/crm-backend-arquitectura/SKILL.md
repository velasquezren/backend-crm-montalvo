---
name: crm-backend-arquitectura
description: Infraestructura, despliegue y diagnóstico de rendimiento del backend CRM. Consultar la sección pertinente para operaciones del VPS, preparación de una base descartable o un incidente medido. Para orientación general usar docs/PANORAMA.md; para código de módulos, crm-backend-module.
---

# Mapa del backend — CRM Clínica Montalvo

Procedimientos de operación y evidencia de infraestructura observada desde
agosto de 2026, con actualizaciones fechadas por sección. La migración de VPS
y la llegada de Resultados invalidaron varias cifras anteriores: conservarlas
como antecedentes, no como prueba de recursos o configuración actuales.

**Este skill NO repite `crm-backend-module`** (paginación, roles, DTOs, webhooks,
concurrencia). Léelos como un par: ese es el "cómo escribo código en un módulo",
este es "dónde vive el sistema y qué tan grande es de verdad".

## Consulta por tarea

No cargar este documento entero al entrar al repo. Orientación general:
[PANORAMA](../../../docs/PANORAMA.md). Para despliegue, leer §4 completo; para
base descartable y pruebas, §8; para una decisión arquitectónica, §5; para
diagnóstico, §7 y la fecha de sus mediciones. §3 es historia medida; §9 resume el endurecimiento vigente.
Las cifras observadas no acreditan recursos libres ni seguridad actuales.

## Referencias por tema (carga solo la que toque)

Cada archivo es una sección completa de esta skill; no hace falta leerlas todas.

- [2. Infraestructura registrada — verificar antes de operar](references/infraestructura-registrada-verificar-antes-de-operar.md) — Desde el 2026-09-21 ya NO está dedicado a este CRM. El portal de Resultados
- [3. Escala real de datos (medida en producción, no estimada)](references/escala-real-de-datos.md) — Remedido el 2026-09-02 (pg_stat_user_tables); entre paréntesis, lo que
- [4. Cómo desplegar](references/como-desplegar.md) — Sin entorno de staging (CLAUDE.md lo dice arriba de todo): esta secuencia es la
- [5. Decisiones de arquitectura ya tomadas — no las reabras sin el porqué](references/decisiones-de-arquitectura-ya-tomadas-no.md) — Cada una de estas resuelve algo específico del contexto de §2 (máquina
- [6. Credenciales y acceso — deliberadamente NO están en este archivo](references/credenciales-y-acceso-deliberadamente-no-estan.md) — Este archivo vive en el repo (.claude/skills/) y probablemente termina en
- [7. Dónde mirar para rendimiento y escalabilidad](references/donde-mirar-para-rendimiento-y-escalabilidad.md) — Las mediciones de esta sección son de agosto/septiembre. El inbox ya recibió
- [8. Verificación según el cambio](references/verificacion-segun-el-cambio.md) — Para documentación, bastan las comprobaciones documentales indicadas en
- [9. Endurecimiento de la máquina: qué quedó y qué no](references/endurecimiento-de-la-maquina-que-quedo.md) — El 2026-09-02 se optimizó la máquina anterior (AlmaLinux, un núcleo,
- [10. Vínculos](references/vinculos.md) — (comisiones en dólares, notificaciones, caché).

## 1. El sistema, en una pantalla

```
Angular 22 (PWA)  ──HTTPS──▶  Apache 2.4 / MPM event (crm.107.175.132.15.nip.io)
en Vercel                      TLS Let's Encrypt, HTTP/2 al navegador
                                │
                                ├─ proxy HTTP/1.1 ──▶ NestJS (127.0.0.1:3001)
                                └─ proxy WS (socket.io) ──▶ mismo puerto
                                                              │
                                                        Postgres 16
                                                    (localhost:5432, bases CRM y Resultados)
```

- **Backend** (este repo): NestJS 11 (Express 5) + Prisma 7 + PostgreSQL, TypeScript estricto.
  Subido desde Nest 10 el 23/10/2026. **NestJS 12 espera a Node 24 en el VPS**: sus
  paquetes son solo ESM y Jest solo los carga desde Node 24.9 (guía oficial de
  migración). Subir los dos a la vez, con `.nvmrc`, CI y servidor en la misma versión.
- **Frontend**: Angular 21, PWA, en el repo hermano `frontend-crm-montalvo/`,
  desplegado en **Vercel** — no vive en el mismo servidor que el backend.
- El backend NO sirve HTML ni assets: es una API REST + un gateway WebSocket.
- `CRM_MANIFESTO.md` (en el repo del frontend) es la referencia de arquitectura
  que gobierna los dos repos; los skills de acá la citan.

## Mantenimiento de este archivo

A diferencia de `crm-backend-module`, `check:skills` no verifica los datos de
infraestructura de este archivo (IPs, RAM, nombres de servicio) porque viven
fuera del repo — nadie los va a detectar desincronizados automáticamente. Si
el servidor cambia (más RAM, otra máquina, otro proveedor), **actualizá este
archivo a mano** en el mismo cambio, o se vuelve la misma clase de mentira
silenciosa que `check:skills` existe para evitar en el resto de los skills.

Recepción (`RECEPCION`) y el asistente del médico (`ASISTENTE`) atienden solo líneas asignadas; comparten rango 0 y la lista `ROLES_OPERATIVOS` de `common/auth/roles.ts`, que es lo que distingue «sin alcance comercial» de un simple nombre de rol. `LineasWhatsappModule` administra catálogo, credenciales y destinatarios; los transportes reciben credenciales explícitas por conversación. La identidad del chat es cliente + línea.
