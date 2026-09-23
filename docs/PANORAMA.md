# Panorama del sistema

El mapa de **qué hay hoy**, en una página. No es historia —eso vive en
[ESTADO_ACTUAL](ESTADO_ACTUAL.md)— ni las reglas de código —eso vive en los
skills—. Es lo que hace falta para ubicarse antes de tocar nada.

**Se mantiene solo con ayuda:** `npm run check:skills` falla si un módulo de
`src/modules/` no aparece aquí o si aquí se cita uno que ya no existe. Las
listas del manifiesto se pudrieron justo por no tener eso.

Actualizado el **2026-09-23**.

## Los tres productos

| Producto | Qué es | Dónde corre | Cómo se despliega |
| --- | --- | --- | --- |
| **CRM Montalvo** | Atención por WhatsApp, leads, ventas, comisiones y finanzas de la clínica | API NestJS en `107.175.132.15` (`crm_backend`, `:3001`) · interfaz Angular en Vercel | Backend: a mano, receta en `crm-backend-arquitectura` §4 · Frontend: `git push` a `main` |
| **Resultados Montalvo** | Portal donde los médicos publican informes y el paciente los abre desde un enlace | Mismo servidor: API `:3010`, portal Next `:3011`, worker de limpieza | Versiones en `/opt/montalvo-resultados/releases/`; ver `docs/operacion.md` de su repo |
| **Agenda médica** | Horario clínico de los médicos. **Sin relación** con el CRM | VPS viejo `107.172.193.34` (FastAPI `:8001`) | Propio |

Los dos primeros comparten servidor y Postgres (bases separadas) y se hablan
**por loopback** con una credencial de solo lectura y renovación de enlaces.
**El CRM es el único que envía WhatsApp**, también los avisos de resultados.

## Backend del CRM — módulos (`src/modules/`)

| Módulo | Qué hace | Quién entra |
| --- | --- | --- |
| `modules/auth` | Login, sesiones revocables, refresco con cookie, perfil propio | Todos |
| `modules/usuarios` | Cuentas, roles y líneas de cada usuario | SUPER_ADMIN |
| `modules/lineas-whatsapp` | Las cuatro líneas de WhatsApp y quién atiende cada una | Lectura: cada uno las suyas · edición: SUPER_ADMIN |
| `modules/conversaciones` | Inbox: webhook de Meta, envío, media en R2, plantillas, reintentos, acuse fuera de horario, alertas de plataforma y tiempo real | Todos, por línea |
| `modules/plantillas-agente` | Respuestas rápidas personales (atajos con «/») | Todos |
| `modules/memoria-agente` | Biblioteca personal de textos y archivos (30 MB) para el chat | Todos |
| `modules/actividades` | Recordatorios y calendario de seguimiento, con push | Todos (operativos sin leads) |
| `modules/clientes` | Fichas de pacientes (≈16.000, importadas de FileMaker), categoría, PAC; reconoce pacientes de otros sistemas | AGENTE+ |
| `modules/leads` | Embudo comercial, Lead Ads de Meta (`/webhooks/meta`) y alta presencial | AGENTE+ |
| `modules/ventas` | Registro de ventas, catálogo, atribución al lead de origen | AGENTE+ (estado: ADMIN) |
| `modules/kpis` | Números del dashboard, medidos sobre los mensajes | AGENTE+ |
| `modules/resultados` | Cola de informes del portal y envío del enlace al paciente | ASISTENTE y ADMIN+, con la línea de resultados |
| `modules/servicios` | Historial clínico importado, médicos y demografía | ADMIN+ |
| `modules/planilla-comisiones` | Importar el Excel de FileMaker, calcular, revisar, aprobar y exportar comisiones | ADMIN+ (aprobar/pagar: SUPER_ADMIN) |
| `modules/tipo-cambio` | Tipo de cambio Bs/USD, sincronizado a diario | Lectura AGENTE+ · corrección ADMIN+ |

Transversal en `src/common/`: auditoría, roles y guards, caché en memoria,
fechas en la zona de La Paz, `enSegundoPlano`, logging con `requestId`, push
web, almacenamiento R2 y el cliente de WhatsApp Cloud.

Tamaños de referencia: `planilla-comisiones` ≈ 13.800 líneas y
`conversaciones` ≈ 7.200 son los dos grandes; el resto, menos de 2.000.

## Frontend del CRM — pantallas (`src/app/features/`)

| Pantalla | Ruta | Quién la ve |
| --- | --- | --- |
| Dashboard | `/dashboard` | AGENTE+ |
| WhatsApp | `/conversaciones` | Todos |
| Actividades | `/actividades` | Todos |
| Entrega de Resultados | `/resultados` | ASISTENTE, ADMIN+ |
| Clientes y Pacientes | `/clientes` | AGENTE+ |
| Leads y Prospectos | `/leads` | AGENTE+ |
| Ventas | `/ventas` | AGENTE+ |
| Finanzas & Comisiones | `/finanzas` (liquidación, desempeño, analítica, anual) | ADMIN+ |
| Historial de Servicios | `/servicios` | ADMIN+ |
| Líneas WhatsApp | `/lineas-whatsapp` | SUPER_ADMIN |
| Usuarios y Accesos | `/usuarios` | SUPER_ADMIN |
| Perfil (incluye Mi Memoria) | `/perfil` | Todos |

Quien entra sin permiso a una ruta vuelve a su bandeja de WhatsApp. El menú,
el guard de la ruta y el backend dicen lo mismo; el backend es la autoridad.

## Roles

`RECEPCION` y `ASISTENTE` (0) < `AGENTE` (1) < `ADMIN` (2) < `SUPER_ADMIN` (3),
más dos capacidades que el rango no expresa, definidas en `common/auth/roles.ts`
y su espejo del frontend:

- **Operativos** (recepción y asistente): atienden **todos** los chats de sus
  líneas, sin alcance comercial —sin leads, fichas completas ni línea de ventas—.
- **Entregar resultados**: asistente y administración, y además con acceso a la
  línea de resultados.

Verificado por HTTP el 2026-09-22 con una cuenta de cada caso.

## Integraciones externas

| Servicio | Para qué | Dónde se configura |
| --- | --- | --- |
| WhatsApp Cloud API (Meta) | Cuatro líneas; una app y un `META_APP_SECRET` para todas | `.env` del servidor + pantalla Líneas WhatsApp |
| Meta Lead Ads | Leads de formularios de anuncios | `/webhooks/meta` |
| Cloudflare R2 | Media de los chats y de Mi Memoria (URLs firmadas de 15 min) | `.env` (`R2_*`) |
| Web Push (VAPID) | Avisos al teléfono: mensaje entrante y recordatorios | `.env` (`VAPID_*`); **no regenerar las llaves** |
| Portal de Resultados | Cola de informes y renovación de enlaces | `.env` (`PORTAL_RESULTADOS_*`, `RESULTADOS_*`) |

## Límites conocidos

Lo que se sabe y se decidió no cambiar todavía, con su motivo:

1. **El último mensaje por conversación del inbox** se elige en JavaScript sobre
   todos los mensajes de la página (`take: 1` no limita por conversación en
   Prisma). Hoy ~3 ms; crece con la tabla `Mensaje`. Señal para actuar: inbox
   sostenido por encima de ~150 ms de servidor.
2. **Preflight por conversación** al abrir un chat. Sin medición de navegador
   que diga que se nota.
3. **`x-force-reload`**: el frontend sabe recargar la PWA con esa cabecera y el
   backend nunca la emite. Palanca de emergencia sin usar.
4. **`Lead.estado` no se reconcilia** al corregir `Venta.leadId`. La atribución
   se lee de `Venta.leadId`; el estado del lead casi nunca se mueve a mano.

Resuelto el 2026-09-23 y fuera de esta lista: el tipo de adjunto saliente se
decidía por la extensión (ahora por `mediaMime`); el texto que acompañaba a una
foto no le llegaba al paciente; buscar dentro de un chat solo miraba los
mensajes cargados (ahora busca en todo el historial); y un índice duplicado en
`PeriodoComision`.

## Dónde está cada cosa

| Necesito… | Leer |
| --- | --- |
| Cómo se escribe un módulo del backend | skill `crm-backend-module` |
| Servidor, despliegue, escala, rendimiento | skill `crm-backend-arquitectura` |
| Cómo se escribe una pantalla | skill `crm-feature-page` (frontend) |
| Colores, átomos, geometría | skill `crm-design-system` (frontend) |
| El inbox de WhatsApp | skill `crm-conversaciones` (frontend) |
| Comisiones y finanzas | skill `crm-finanzas` (frontend) |
| Qué cambió y cuándo | [ESTADO_ACTUAL](ESTADO_ACTUAL.md) |
| Auditorías cerradas F01–F10, rendimiento R3, campañas | `docs/auditoria-*.md`, `docs/rendimiento-r3-2026-09.md`, `docs/CAMP-*.md` |
