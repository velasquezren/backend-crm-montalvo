# Panorama del sistema

El mapa de **qué hay hoy**, en una página. No es historia —eso vive en
[ESTADO_ACTUAL](ESTADO_ACTUAL.md)— ni las reglas de código —eso vive en los
skills—. Es lo que hace falta para ubicarse antes de tocar nada.

**Se mantiene solo con ayuda:** `npm run check:skills` falla si un módulo de
`src/modules/` no aparece aquí o si aquí se cita uno que ya no existe. Las
listas del manifiesto se pudrieron justo por no tener eso.

Actualizado el **2026-10-01**. Backend y frontend publicados y verificados;
versiones y evidencias en [auditoria-2026-10-01](auditoria-2026-10-01.md).

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
| `modules/menu-atencion` | El menú con el que cada línea recibe a la paciente: qué opciones ofrece (persona, emergencia, cita, información, ubicación, promociones) y sus textos. Lo lee la ingesta; solo él escribe `MenuAtencion` ([diseño](menu-atencion.md)) | Edición: SUPER_ADMIN |
| `modules/cobros` | El QR con que cada línea cobra una promoción por WhatsApp (banco, titular, vencimiento). Lo lee el chat cuando la paciente toca «Pagar ahora» ([diseño](pagos-promocion.md)) | Edición: SUPER_ADMIN |
| `modules/conversaciones` | Inbox: webhook de Meta, envío, media en R2, plantillas, reintentos, acuse fuera de horario, abierta/cerrada con cierre por inactividad, bajas de marketing de Meta, alertas de plataforma y tiempo real; la promoción dentro del chat: su código `PRM-…`, la tarjeta y el pago con QR y comprobante hasta la venta ([diseño](pagos-promocion.md)) | Todos, por línea |
| `modules/plantillas-agente` | Respuestas rápidas personales (atajos con «/») | Todos |
| `modules/memoria-agente` | Biblioteca personal de textos y archivos (30 MB) para el chat | Todos |
| `modules/actividades` | Recordatorios y calendario de seguimiento, con push | Todos (operativos sin leads) |
| `modules/clientes` | Fichas de pacientes (≈16.000, importadas de FileMaker), PAC, y su categoría por valor —calculada con FileMaker + CRM, o fijada a mano por SUPER_ADMIN—; reconoce pacientes de otros sistemas | AGENTE+ |
| `modules/campanas` | Campañas de Marketing de punta a punta. **Audiencia** (`GET /campanas/audiencia`, solo lee): a quién mandarle hoy, cruzando la categoría por valor con si conviene escribirle (sin baja, con celular, sin campaña reciente, si ya conversó). **Envío**: una plantilla de Marketing a esa audiencia congelada, a ritmo (80/min) y de 9:00 a 20:00 en La Paz, con sus métricas (entregó, leyó, respondió, compró, costo) | Ver: ADMIN+ · lanzar y controlar: SUPER_ADMIN |
| `modules/promociones` | Promociones de la clínica: la agente las redacta con banners por formato, precio en Bs, vigencia y condiciones; un ADMIN las publica. Cada una sabe qué anuncios de Meta la publicitan, así que el CRM atribuye leads y ventas a la promoción. API pública de solo lectura para la landing (`/publico/promociones`) ([diseño](promociones-y-directorio.md)) | Ver: todos · redactar: AGENTE+ · publicar: ADMIN+ |
| `modules/directorio` | Directorio médico: especialidades, la ficha pública de cada médico (enlazada a su código de FileMaker) y su horario semanal INFORMATIVO, más sus ausencias. Las citas reales siguen en el sistema de agenda de la clínica. API pública para la landing (`/publico/directorio`) ([diseño](promociones-y-directorio.md)) | Ver: todos · editar: ADMIN+ |
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

### Quién escribe cada tabla

La regla es que **cada tabla la escribe su módulo dueño**, y los demás le
piden el cambio a su service. Leer tablas de otro dominio para agregar o
informar está permitido y es lo normal en `modules/kpis` y `modules/servicios`
(Venta, Lead, Mensaje, VentaImportada, Cliente): pasar esas lecturas por
services que solo reenvíen la consulta no aportaría nada.

Estas son las escrituras que **hoy** cruzan la frontera, medidas en el código
el 2026-09-29 (la de la ingesta de WhatsApp sobre Cliente e Interes se retiró
el 2026-09-30: ahora pasa por `ClientesService.registrarCampanaOrigen`). No son descuidos ocultos, sino decisiones o deuda conocida;
si añades otra, añádela aquí con su motivo.

| Quién escribe | Tabla ajena | Dónde | Por qué |
| --- | --- | --- | --- |
| `modules/clientes` | Lead, Conversacion | `cascadaDeReasignacion` (desde `update`/`reasignarAgente`) y `reclamarSiNoTieneDuena` | Reasignar una paciente mueve a la vez sus leads y sus chats de la línea comercial, en la misma transacción |
| `modules/usuarios` | Conversacion | `UsuariosService.update`, al quitar líneas o desactivar | Libera los chats que la persona ya no puede atender, en la misma transacción que el cambio de permisos |
| varios | AuditLog | conversaciones, usuarios, lineas-whatsapp, menu-atencion, promociones, cobros | Escriben la bitácora dentro de su propia transacción cuando el registro tiene que ser atómico con el cambio; fuera de una transacción se usa `AuditService` |

## Frontend del CRM — pantallas (`src/app/features/`)

| Pantalla | Ruta | Quién la ve |
| --- | --- | --- |
| Dashboard | `/dashboard` | AGENTE+ |
| WhatsApp | `/conversaciones` | Todos |
| Actividades | `/actividades` | Todos |
| Entrega de Resultados | `/resultados` | ASISTENTE, ADMIN+ |
| Clientes y Pacientes | `/clientes` | AGENTE+ |
| Leads y Prospectos | `/leads` | AGENTE+ |
| Campañas (pestañas «Campañas» y «Audiencia») | `/campanas` | ADMIN+ (crear, pausar, reanudar, cancelar: SUPER_ADMIN) |
| Promociones (pestañas «Promociones» y «Anuncios de Meta») | `/promociones` | Todos (redactar y anuncios: AGENTE+ · publicar: ADMIN+) |
| Directorio médico (pestañas «Médicos» y «Especialidades») | `/directorio` | Todos (editar: ADMIN+) |
| Ventas | `/ventas` | AGENTE+ |
| Finanzas & Comisiones | `/finanzas` (liquidación, desempeño, analítica, anual) | ADMIN+ |
| Historial de Servicios | `/servicios` | ADMIN+ |
| Líneas WhatsApp | `/lineas-whatsapp` (conexión y menú de atención de cada línea) | SUPER_ADMIN |
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
| Cloudflare R2 | Media de los chats y de Mi Memoria (URLs firmadas); banners de promociones y fotos del directorio, servidos por la API con URL pública inmutable solo si están publicados | `.env` (`R2_*`) |
| Web Push (VAPID) | Avisos al teléfono: mensaje entrante y recordatorios | `.env` (`VAPID_*`); **no regenerar las llaves** |
| Portal de Resultados | Cola de informes y renovación de enlaces | `.env` (`PORTAL_RESULTADOS_*`, `RESULTADOS_*`) |
| Landing pública (Next.js en Vercel) | Lee `/publico/*` con ISR; el CRM le avisa al publicar para que se renueve al instante (`AvisoLandingService`) | `.env` (`LANDING_REVALIDAR_*`) + `CRM_REVALIDAR_SECRETO` en Vercel |

## Límites conocidos

Lo que se sabe y se decidió no cambiar todavía, con su motivo:

1. **Preflight por conversación** al abrir un chat. Sin medición de navegador
   que diga que se nota.
2. **`x-force-reload`**: el frontend sabe recargar la PWA con esa cabecera y el
   backend nunca la emite. Palanca de emergencia sin usar.
3. **`Lead.estado` no se reconcilia** al corregir `Venta.leadId`. La atribución
   se lee de `Venta.leadId`; el estado del lead casi nunca se mueve a mano.
4. **Dependencias heredadas:** `npm audit --omit=dev` reporta 21 entradas
   (10 altas, 10 moderadas y 1 baja; ninguna crítica). No equivale a 21 fallos
   explotables comprobados, pero requiere remediación y verificación propias;
   varios cambios propuestos son mayores y `xlsx` no tiene solución en npm.

Resuelto y desplegado el 2026-10-01: el último mensaje del inbox se limita en
PostgreSQL con `LATERAL … LIMIT 1`, para los IDs ya autorizados de la página.
Las campañas recuperan reservas en cada vuelta con bloqueo por paciente y
reutilizan el mensaje persistido. Evidencia y límites en
[auditoria-2026-10-01](auditoria-2026-10-01.md).

Resuelto el 2026-09-30 y fuera de esta lista: la categoría del paciente no
caducaba y salía solo de las ventas del CRM. Ahora se calcula por valor
(FileMaker + CRM, 12 meses) cada 6 h y se puede fijar a mano; ver
`clientes/categoria-paciente.ts`.

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
| Plantillas de WhatsApp preparadas y cómo activarlas | [plantillas-whatsapp](plantillas-whatsapp.md) |
| Promociones, directorio médico y la API pública de la landing | [promociones-y-directorio](promociones-y-directorio.md) |
| Cobrar una promoción por WhatsApp (QR, comprobante, venta) | [pagos-promocion](pagos-promocion.md) |
| Qué cambió y cuándo | [ESTADO_ACTUAL](ESTADO_ACTUAL.md) |
| Auditorías cerradas F01–F10, rendimiento R3, campañas | `docs/auditoria-*.md`, `docs/rendimiento-r3-2026-09.md`, `docs/CAMP-*.md` |
