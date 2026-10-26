# Panorama del sistema

Mapa de responsabilidades, conciliado con el código el **15/10/2026**.
`check:skills` comprueba presencia de módulos, no toda la descripción ni el
estado remoto. [Índice por tarea](README.md) · [Estado breve](ESTADO_ACTUAL.md).

## Productos y límites

| Sistema | Responsabilidad | Integración |
| --- | --- | --- |
| CRM | Atención WhatsApp, ventas, seguimiento y liquidación | NestJS/PostgreSQL en VPS CRM; Angular en Vercel |
| Resultados | Publicación y acceso a informes | Repo independiente; API/portal/worker en el VPS CRM, base propia; integración privada. Solo el CRM envía WhatsApp |
| Agenda clínica | Cupos, reservas y citas | ScriptCase/MySQL en el VPS de agenda, conectado con FileMaker; [contrato](agenda.md). No es Actividades ni el antiguo FastAPI |
| Landing | Presentación pública y reserva web | Repo `montalvo` (remoto `landing-montalvo`); consume API pública del CRM |

Inventario operativo y receta de despliegue en
[arquitectura](../.claude/skills/crm-backend-arquitectura/SKILL.md), solo para
trabajos de infraestructura. IP, métricas y banderas documentadas no son una
comprobación en vivo. No confundir el alias local del VPS de agenda con el CRM.

## Backend del CRM — módulos (`src/modules/`)

| Módulo | Qué hace | Quién entra |
| --- | --- | --- |
| `modules/auth` | Login, sesiones revocables, refresco con cookie, perfil propio | Todos |
| `modules/agenda` | Catálogo/cupos MySQL; reserva compartida por web, Flow e IA; consulta clínica y administración; horarios FileMaker y acceso de médicos por WhatsApp. [Dueños, cuentas y contratos](agenda.md) | Público según endpoint; consulta/edición clínica según capacidades en `roles.ts` |
| `modules/usuarios` | Cuentas, roles y líneas de cada usuario | SUPER_ADMIN |
| `modules/lineas-whatsapp` | Las cuatro líneas de WhatsApp y quién atiende cada una | Lectura: cada uno las suyas · edición: SUPER_ADMIN |
| `modules/menu-atencion` | El menú con el que cada línea recibe a la paciente: qué opciones ofrece (persona, emergencia, cita, información, ubicación, promociones) y sus textos. Lo lee la ingesta; solo él escribe `MenuAtencion` ([diseño](menu-atencion.md)) | Edición: SUPER_ADMIN |
| `modules/cobros` | El QR con que cada línea cobra una promoción por WhatsApp (banco, titular, vencimiento). Lo lee el chat cuando la paciente toca «Pagar ahora» ([diseño](pagos-promocion.md)) | Edición: SUPER_ADMIN |
| `modules/conversaciones` | Inbox: webhook de Meta, envío, media en R2, plantillas, reintentos, acuse fuera de horario, abierta/cerrada con cierre por inactividad, bajas de marketing de Meta, alertas de plataforma y tiempo real; la promoción dentro del chat: su código `PRM-…`, la tarjeta y el pago con QR y comprobante hasta la venta ([diseño](pagos-promocion.md)); dueño de `TrabajoTranscripcionAudio` (transcripción interna sin respuestas) y `ReservaChat`, cola durable, QR de reservas hechas por Flow y la constancia en imagen cuando el comprobante queda registrado (`ConstanciaReservaService`), sin duplicar la agenda ni confirmar pagos ([operación](reservas-pago-chat.md)) | Todos, por línea |
| `modules/plantillas-agente` | Respuestas rápidas personales (atajos con «/») | Todos |
| `modules/memoria-agente` | Biblioteca personal de textos y archivos (30 MB) para el chat | Todos |
| `modules/asistente` | Proveedor Gemini, clasificación, herramientas, bucle, imágenes y configuración por línea. Conversaciones orquesta los efectos; el código valida y registra reservas y entrega QR. [Asistente](asistente-ia.md) | Configura SUPER_ADMIN; ejecutan los servicios de Conversaciones según modo y banderas |
| `modules/actividades` | Recordatorios y calendario de seguimiento, con push. [Seguimiento automático de reservas](reservas-actividades.md), detrás de `RESERVAS_ACTIVIDADES`: tarea única por reserva, reconciliación del QR y campanita | Manuales: propias (ADMIN+ global). Reservas: acceso al chat; externas: roles de agenda clínica. Operativos sin leads |
| `modules/clientes` | Fichas de pacientes (≈16.000, importadas de FileMaker), PAC, y su categoría por valor —calculada con FileMaker + CRM, o fijada a mano por SUPER_ADMIN—; reconoce pacientes de otros sistemas | AGENTE+ |
| `modules/campanas` | Campañas de Marketing de punta a punta. **Audiencia** (`GET /campanas/audiencia`, solo lee): a quién mandarle hoy, cruzando la categoría por valor con si conviene escribirle (sin baja, con celular, sin campaña reciente, si ya conversó). **Envío**: una plantilla de Marketing a esa audiencia congelada, a ritmo (80/min) y de 9:00 a 20:00 en La Paz, con sus métricas (entregó, leyó, respondió, compró, costo) | Ver: ADMIN+ · lanzar y controlar: SUPER_ADMIN |
| `modules/promociones` | Promociones de la clínica: la agente las redacta con banners por formato, precio en Bs (o varios **servicios**, cada uno con su precio: `PromocionServicio`, uno por pago por WhatsApp), vigencia y condiciones; un ADMIN las publica. Cada una sabe qué anuncios de Meta la publicitan, así que el CRM atribuye leads y ventas a la promoción. API pública de solo lectura para la landing (`/publico/promociones`) ([diseño](promociones-y-directorio.md)) | Ver: todos · redactar: AGENTE+ · publicar: ADMIN+ |
| `modules/directorio` | Presentación pública: especialidades, `PerfilMedico`, fotos, publicación, horario informativo y ausencias. Para médicos enlazados recibe precio/horario de Agenda; no calcula cupos clínicos. [Guía](promociones-y-directorio.md) | Público solo publicado; edición de presentación vía servicios y capacidades correspondientes |
| `modules/leads` | Embudo comercial, Lead Ads de Meta (`/webhooks/meta`) y alta presencial | AGENTE+ |
| `modules/ventas` | Registro de ventas, catálogo, atribución al lead de origen | AGENTE+ (estado: ADMIN) |
| `modules/conversiones-meta` | Aviso a Meta de las ventas que vinieron de un anuncio de Click-to-WhatsApp (Conversions API), **apagado** sin `META_CONVERSIONES`. Dueño de `ConversionMeta`, un outbox que Ventas llena en su transacción y que se revalida al enviarse; solo viajan clic, WABA, monto y hora ([guía y decisiones de la clínica](conversiones-meta.md)) | Sin endpoints; lo dispara Ventas |
| `modules/kpis` | Números del dashboard, medidos sobre los mensajes. `GET /kpis/resumen` (lo que pide acción, tarjetas, embudo, serie, canales, equipo; caché 15 s) y `GET /kpis/detalle` (primera respuesta por tramos, leads por día y hora de La Paz, chats por línea, pacientes por categoría y el asistente —este solo sin alcance de agente—; caché 60 s), que el Dashboard pide al llegar a esa zona | AGENTE+ |
| `modules/resultados` | Cola de informes, enlace al paciente y autoconsulta por WhatsApp. [Contrato de entrega](informes-por-whatsapp.md) | Operación: ASISTENTE y ADMIN+ con línea; autoconsulta: identidad revalidada por el portal |
| `modules/servicios` | Historial clínico importado, médicos y demografía | ADMIN+ |
| `modules/planilla-comisiones` | Importar el Excel de FileMaker, calcular, revisar, aprobar y exportar comisiones | ADMIN+ (aprobar/pagar: SUPER_ADMIN) |
| `modules/tipo-cambio` | Tipo de cambio Bs/USD, sincronizado a diario | Lectura AGENTE+ · corrección ADMIN+ |

Transversal en `src/common/`: auditoría, roles y guards, caché en memoria,
fechas en la zona de La Paz, `enSegundoPlano`, logging con `requestId`, push
web, almacenamiento R2, el cliente de WhatsApp Cloud (con su destino por
teléfono o BSUID, `whatsapp/destino.ts`), el rastreo de errores y las tareas
periódicas (`trabajos/`: `@TareaPeriodica`, con pg-boss si `TRABAJOS_PGBOSS=on`).

### Quién escribe cada tabla

`modules/agenda` es dueño de `HorarioFilemaker`: conserva la última revisión y
su estado pendiente para aplicar horarios de consulta a MySQL y, mediante
`DirectorioService`, a la ficha web. La integración está desplegada y activa en
producción (15/10); FileMaker es el editor y el CRM solo consulta los horarios.
Falta completar el primer envío desde el archivo local. No escribe citas ni pagos. Contrato, límites y
activación en [filemaker-horarios.md](filemaker-horarios.md).

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
| varios | AuditLog | conversaciones, usuarios, lineas-whatsapp, menu-atencion, promociones, cobros, agenda, asistente | Escriben la bitácora dentro de su propia transacción cuando el registro tiene que ser atómico con el cambio; fuera de una transacción se usa `AuditService`. `agenda` la escribe directo y ANTES de entregar un comprobante: sin constancia no se entrega; y dentro de la transacción de MySQL al editar médicos y horarios: si la constancia falla, el cambio se deshace |

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
| Directorio médico | `/directorio` | Todos; edición de agenda: RECEPCION y ADMIN+. Presentación pública según su endpoint |
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
más capacidades que el rango no expresa, definidas en `common/auth/roles.ts`
y su espejo del frontend:

- **Operativos** (recepción y asistente): atienden **todos** los chats de sus
  líneas, sin alcance comercial —sin leads, fichas completas ni línea de ventas—.
- **Entregar resultados**: asistente y administración, y además con acceso a la
  línea de resultados.

Para permisos actuales consultar `common/auth/roles.ts`, guards y tests HTTP;
los roles de agenda distinguen consulta clínica de edición.

## Integraciones externas

| Servicio | Para qué | Dónde se configura |
| --- | --- | --- |
| WhatsApp Cloud API (Meta) | Líneas configurables; una app y un `META_APP_SECRET` para todas | `.env` del servidor + pantalla Líneas WhatsApp |
| Gemini | Clasificación, conversación, audio y lectura de comprobantes (promociones y citas del chat) | `.env.example` + configuración del asistente por línea |
| Meta Lead Ads | Leads de formularios de anuncios | `/webhooks/meta` |
| Meta Conversions API | Aviso de ventas de anuncios de Click-to-WhatsApp, apagado por defecto | `.env` (`META_CONVERSIONES*`); [guía](conversiones-meta.md) |
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
4. **Dependencias heredadas:** hallazgos fechados en la
   [auditoría del 1/10](auditoria-2026-10-01.md). Revalidar contra el lockfile y
   el aviso vigente antes de remediar; sus conteos no son cifras actuales.

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

El [índice único por responsabilidad](README.md) reúne guías, código y pruebas.
Estado pendiente en [ESTADO_ACTUAL](ESTADO_ACTUAL.md); entregas pasadas en el
historial enlazado desde allí. No mantener otra lista de fases en este mapa.
