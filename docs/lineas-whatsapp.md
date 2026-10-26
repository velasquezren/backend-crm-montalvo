# Líneas de WhatsApp y acceso por recepción

Modelo implementado el 14/09/2026; permisos actualizados con el código del
15/10. La tabla siguiente describe el **estado inicial de la migración**, no
la conectividad actual. Despliegues posteriores en el [historial](historial/estado-2026-10.md).

| Canal | Número | Estado inicial |
| --- | --- | --- |
| Ventas y publicidad Montalvo | Número existente del servidor | Conserva las credenciales actuales |
| Laboratorio CLIMON | +591 62140323 | Pendiente de conexión |
| Recepción Clínica Montalvo Corporativo | +591 75031306 | Pendiente de conexión |
| Centro Médico Montalvo | +591 76065490 | Pendiente de conexión |

## Modelo y autorización

`LineaWhatsapp` contiene identidad, nombre visible y referencia a una variable de entorno para su token. Los secretos nunca se guardan en el navegador ni salen en las respuestas de la API. `AccesoLineaWhatsapp` relaciona usuarios con líneas. `Conversacion` es única por `(clienteId, lineaId)`: un paciente puede escribir a varias líneas conservando conversaciones separadas. El historial previo queda en ventas, sin borrar ni duplicar mensajes. La migración concede acceso a ventas a los AGENTE existentes; los usuarios nuevos requieren asignación explícita.

ADMIN y SUPER_ADMIN ven todos los canales. AGENTE necesita membresía y alcance
comercial del chat/paciente. RECEPCION y ASISTENTE ven todos los chats de sus
líneas asignadas, aunque los atienda otra persona; no admiten líneas comerciales.
También tienen Actividades y capacidades de agenda clínica; ASISTENTE puede
entregar resultados con acceso a esa línea. Consultar `common/auth/roles.ts`,
`acceso-conversacion.ts` y sus tests para cada operación.

Listado, búsqueda, contadores, detalle, historial, lectura y envío aplican el mismo límite de línea. WebSocket y push consultan los permisos vigentes. Cambiar las líneas, el rol o el estado de una cuenta invalida sus sesiones anteriores; las conversaciones que queden fuera de su alcance se devuelven al pool. Reasignar un chat cambia solo ese chat, sin alterar la atribución comercial del paciente ni sus leads. Los envíos de recepción tampoco reclaman la propiedad comercial del paciente.

El frontend muestra nombre y número del canal en el hilo y permite filtrar la bandeja por línea. La gestión de usuarios permite asignar varias líneas explícitas y crear cuentas RECEPCION. El selector de asignación muestra usuarios autorizados para la línea del chat. Las respuestas tardías de otro contexto no deben restaurar borradores o adjuntos al cambiar de chat/sesión.

## Conexión y operación

1. Publicar y desplegar **primero el backend**: respaldo, `prisma migrate deploy`, generación del cliente, build y reinicio. Comprobar salud, catálogo de líneas y presencia de `linea` en listado/detalle/resumen. Solo después publicar el frontend: su push a `main` dispara Vercel, mientras que el push del backend no actualiza el VPS. El frontend nuevo requiere la respuesta `linea` del backend nuevo.
2. Registrar o incorporar cada número en la plataforma de Meta y obtener su **Phone Number ID** y **WABA ID**. El teléfono visible no sustituye esos identificadores.
3. Configurar las variables del servidor `WHATSAPP_CLIMON_TOKEN`, `WHATSAPP_RECEPCION_TOKEN` y `WHATSAPP_CENTRO_TOKEN`, con acceso a sus cuentas correspondientes. No pegar tokens en el CRM: la pantalla solo pide el nombre de la variable.
4. Como SUPER_ADMIN, abrir **Líneas de WhatsApp**, completar teléfono, Phone Number ID, WABA ID y referencia de credencial. Habilitar después de comprobar la asociación correcta en Meta. “Configurada” indica presencia de configuración, no una prueba de conectividad en vivo.
5. Suscribir la aplicación del CRM a las cuentas correspondientes para recibir `messages` en `/webhooks/whatsapp`; verificar la firma con `META_APP_SECRET`. Esta implementación usa una aplicación Meta y su secreto para las líneas. Varias WABA pueden compartirla. No mezclar aplicaciones con secretos distintos sin añadir su resolución explícita.
6. En **Usuarios**, asignar cada recepción a sus líneas. Crear usuarios sin líneas no concede acceso al pool comercial. Volver a iniciar sesión después de cambiar permisos.
7. Probar desde un teléfono externo: mensaje entrante, etiqueta de canal, respuesta desde el mismo número, acuses, archivo, plantilla y acceso de recepción frente al administrador.

La línea comercial conserva como compatibilidad `WHATSAPP_TOKEN`/`WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_ID`/`WHATSAPP_PHONE_NUMBER_ID` y `WHATSAPP_WABA_ID`. Ninguna línea nueva hereda esas credenciales. Los envíos, reintentos, medios, lectura y plantillas resuelven la cuenta de la conversación. El identificador de una línea con historial no se puede reemplazar por otro número ya configurado; las credenciales sí pueden rotarse.

El webhook identifica cada cambio por `metadata.phone_number_id`. Un identificador ausente o desconocido **se descarta con 200** y no se atribuye a ventas: es un fallo permanente, y el reintento que pide un 503 nunca podría entrar — Meta acabaría desactivando la suscripción de la app, que es la misma para las cuatro líneas. El aviso del journal lleva el `phone_number_id`, el número legible y los ids descartados, que es lo que hace falta para dar de alta la línea y recuperarlos a mano. Un fallo **transitorio** al resolver la línea (base caída) sí devuelve 503. El 200 se emite después de persistir; si falla un elemento, se procesan los demás y se devuelve 503. `whatsappMsgId` deduplica lo ya persistido en los reintentos. Las ofertas comerciales y el alta automática de leads se aplican a líneas
comerciales. En atención también puede crearse ficha y conversación, sin
crear por ello un lead comercial (`obtenerOCrearConversacion`,
`PrimerContactoWhatsapp` y guardas `linea.comercial` en la ingesta).

## Números atendidos actualmente desde la app

El alta inicial del 14/09 no conectó las líneas nuevas. Hay activaciones
posteriores registradas en el historial; la conectividad actual se verifica
en el catálogo y Meta. Registrar teléfonos en una migración **no los conecta**. Antes del alta, confirmar si cada línea utiliza WhatsApp Business o WhatsApp personal y determinar el procedimiento admitido por Meta para esa cuenta. No eliminar la cuenta de la app como paso automático.

Esta entrega cubre mensajería Cloud API y permisos del CRM. No implementa Embedded Signup, importación del historial de la app ni sincronización de mensajes enviados desde la app (`smb_message_echoes`). Por ello no debe anunciarse coexistencia app + CRM como operativa. Si se requiere conservar ambos canales de atención simultáneamente, completar primero ese flujo y sus pruebas con la cuenta real.

Referencias oficiales para el alta: [WhatsApp Cloud API de Meta](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api) y [Embedded Signup de Meta](https://www.postman.com/meta/whatsapp-business-platform/documentation/du6gzjv/embedded-signup). La disponibilidad concreta del flujo para estas tres cuentas queda por verificar.

## Nombres de usuario de WhatsApp (BSUID, 23/10/2026)

Desde 2026 una persona puede adoptar un nombre de usuario en WhatsApp. Si lo hizo
y la línea no tuvo trato con su número en 30 días (ni está en la libreta de
contactos de Meta), el webhook **no trae su teléfono**: `messages[].from` y
`contacts[].wa_id` faltan y solo llega su BSUID (`from_user_id`, `contacts[].user_id`,
`BO.` + hasta 128 alfanuméricos), propio de esta empresa. Meta lo manda en todos los
mensajes desde abril de 2026 y acepta enviar a un BSUID (`recipient`) desde julio.
Hasta este cambio el webhook descartaba ese mensaje sin rastro.

- **Ficha.** `Cliente.telefono` es opcional y `Cliente.waUsuarioId` guarda el BSUID
  (único). La base exige uno de los dos (`Cliente_contacto_whatsapp_check`).
  `ClientesService.obtenerOCrearPorWhatsapp` busca por BSUID, luego por teléfono
  (la ficha de siempre recibe su BSUID), y si no, da de alta; bajo carrera
  resuelve el P2002 releyendo. Si llega el número de una ficha-BSUID y ese número ya
  es de otra ficha, **no se fusionan**: queda `POSIBLE_DUPLICADO` en `AuditLog`.
- **Envío.** Nadie usa `cliente.telefono` para mandar: `destinoWhatsapp` (en
  `common/whatsapp/destino.ts`) devuelve el teléfono si lo hay y si no el BSUID, y
  `WhatsappCloudService.enviar` pone `to` o `recipient`. `normalizarTelefono`
  rechaza un BSUID: la librería leía `BO.70012345` como `+59170012345`.
- **Lo que exige un número** no se ofrece sin él: el Flow de reserva con endpoint
  (su token sella el teléfono) responde que una persona coordinará la cita; la
  reserva del asistente ya exigía celular boliviano; «Mis informes» falla cerrado y
  pide revisión; un médico se autoriza por número; la audiencia de campañas exige
  celular. Las plantillas de autenticación no admiten BSUID (error 131062).
- **Cambios de identidad.** Los mensajes de sistema `user_changed_user_id` y
  `user_changed_number` pasan la ficha del `previous_user_id` al nuevo
  (`cambiarWaUsuarioId`). Las bajas de marketing (`user_preferences`) se reconocen
  también por `user_id`.
- **Frontend.** El inbox y la ficha muestran «@usuario» o «Usuario de WhatsApp» y
  ocultan llamar/wa.me/copiar número; la ficha se edita sin teléfono y se le puede
  añadir uno cuando lo comparta.

Despliegue: la migración `20261023210000_contacto_whatsapp_bsuid` es aditiva. Publicar
el frontend antes o junto con el backend: uno anterior no espera `telefono: null`.

## Verificación local

`lineas-whatsapp.integracion.spec.ts` usa PostgreSQL real y HTTP Nest con JWT, ValidationPipe y webhook firmado; solo simula salidas externas (Meta, R2 y push). Incluye aislamiento de bandeja/historial/mutaciones, permisos de usuario, separación por número, credenciales de envío/lectura/plantillas, adjuntos cruzados, idempotencia y estados de otra línea. Las suites de conversaciones, autenticación y fiabilidad verifican las regresiones existentes.

La integración se ejecuta exclusivamente contra `crm_test` descartable en loopback: no ejecutar `test:integracion:preparar` sobre una base con datos que deban conservarse. Las pruebas de conciliación de comisiones que dependen de Excel privados mantienen su limitación anterior cuando faltan esos archivos. No se probó el envío a Meta real ni se usó navegador en esta entrega.

Resultado del 14-09-2026: builds de ambos repositorios correctos; 93 pruebas frontend; 509 unitarias backend; 20 suites / 376 casos de integración reportados (22 nuevos de líneas); 9 pruebas del artefacto de build. Los conteos financieros incluyen casos sin aserciones por Excel ausentes. Se comprobó además la migración sobre un historial ficticio previo: conserva mensaje y chat, asigna la línea comercial, conserva el acceso del agente y permite otro chat del mismo paciente en CLIMON.

## Incidente de despliegue del 14-09-2026

Vercel había publicado `ae4ddb8`, pero el VPS seguía en `e80fc9f`: faltaba `/lineas-whatsapp` y los chats no incluían `linea`. Esto produjo “No se pudieron cargar las líneas” y el TypeError al leer `linea.nombre`.

Se respaldó la base (`/root/backups-crm/crm-20260914-004058.sql.gz`, 3.599.151 bytes, `gzip -t` correcto), se desplegó `8ef88c1` y se aplicó `20260913120000_lineas_whatsapp_y_accesos`. Servicio activo y salud pública correctos; cuatro líneas registradas, 423 chats y 3.160 mensajes en ventas; dos agentes existentes con acceso comercial. La línea existente resuelve sus credenciales; las tres nuevas permanecen inactivas y sin conectar.

El frontend valida la identidad del canal antes de incorporar listado, detalle, paginación o resumen realtime. Un contrato incompleto presenta un error recuperable y no habilita el compositor. Los consumidores de recursos con error comprueban `hasValue()` antes de leer `value()`; el respaldo vuelve a pedir el catálogo si falló. Validación de la corrección: 98 pruebas frontend y build correctos, incluidas respuestas antiguas sin canal y recuperación al reintentar. No se enviaron mensajes a pacientes durante la verificación.
