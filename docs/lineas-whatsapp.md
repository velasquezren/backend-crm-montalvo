# Líneas de WhatsApp y acceso por recepción

Implementado el 14 de septiembre de 2026. La migración registra estos canales:

| Canal | Número | Estado inicial |
| --- | --- | --- |
| Ventas y publicidad Montalvo | Número existente del servidor | Conserva las credenciales actuales |
| Laboratorio CLIMON | +591 62140323 | Pendiente de conexión |
| Recepción Clínica Montalvo Corporativo | +591 75031306 | Pendiente de conexión |
| Centro Médico Montalvo | +591 76065490 | Pendiente de conexión |

## Modelo y autorización

`LineaWhatsapp` contiene identidad, nombre visible y referencia a una variable de entorno para su token. Los secretos nunca se guardan en el navegador ni salen en las respuestas de la API. `AccesoLineaWhatsapp` relaciona usuarios con líneas. `Conversacion` es única por `(clienteId, lineaId)`: un paciente puede escribir a varias líneas conservando conversaciones separadas. El historial previo queda en ventas, sin borrar ni duplicar mensajes. La migración concede acceso a ventas a los AGENTE existentes; los usuarios nuevos requieren asignación explícita.

ADMIN y SUPER_ADMIN ven todos los canales. AGENTE y RECEPCION necesitan membresía de línea y acceso a la conversación (asignada a ellos o sin asignar; en ventas se conserva también el alcance del propietario comercial del paciente). Recepción no admite la línea comercial. Sus rutas se limitan a conversaciones, perfil y recursos personales. Las rutas comerciales requieren al menos AGENTE.

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

El webhook identifica cada cambio por `metadata.phone_number_id`. Un identificador ausente o desconocido **se descarta con 200** y no se atribuye a ventas: es un fallo permanente, y el reintento que pide un 503 nunca podría entrar — Meta acabaría desactivando la suscripción de la app, que es la misma para las cuatro líneas. El aviso del journal lleva el `phone_number_id`, el número legible y los ids descartados, que es lo que hace falta para dar de alta la línea y recuperarlos a mano. Un fallo **transitorio** al resolver la línea (base caída) sí devuelve 503. El 200 se emite después de persistir; si falla un elemento, se procesan los demás y se devuelve 503. `whatsappMsgId` deduplica lo ya persistido en los reintentos. Las respuestas automáticas comerciales y la creación automática de leads solo se aplican a la línea comercial.

## Números atendidos actualmente desde la app

No se ha modificado ninguna cuenta real de WhatsApp ni se han recibido sus identificadores de Meta. Registrar los teléfonos en esta migración **no los conecta**. Antes del alta, confirmar si cada línea utiliza WhatsApp Business o WhatsApp personal y determinar el procedimiento admitido por Meta para esa cuenta. No eliminar la cuenta de la app como paso automático.

Esta entrega cubre mensajería Cloud API y permisos del CRM. No implementa Embedded Signup, importación del historial de la app ni sincronización de mensajes enviados desde la app (`smb_message_echoes`). Por ello no debe anunciarse coexistencia app + CRM como operativa. Si se requiere conservar ambos canales de atención simultáneamente, completar primero ese flujo y sus pruebas con la cuenta real.

Referencias oficiales para el alta: [WhatsApp Cloud API de Meta](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api) y [Embedded Signup de Meta](https://www.postman.com/meta/whatsapp-business-platform/documentation/du6gzjv/embedded-signup). La disponibilidad concreta del flujo para estas tres cuentas queda por verificar.

## Verificación local

`lineas-whatsapp.integracion.spec.ts` usa PostgreSQL real y HTTP Nest con JWT, ValidationPipe y webhook firmado; solo simula salidas externas (Meta, R2 y push). Incluye aislamiento de bandeja/historial/mutaciones, permisos de usuario, separación por número, credenciales de envío/lectura/plantillas, adjuntos cruzados, idempotencia y estados de otra línea. Las suites de conversaciones, autenticación y fiabilidad verifican las regresiones existentes.

La integración se ejecuta exclusivamente contra `crm_test` descartable en loopback: no ejecutar `test:integracion:preparar` sobre una base con datos que deban conservarse. Las pruebas de conciliación de comisiones que dependen de Excel privados mantienen su limitación anterior cuando faltan esos archivos. No se probó el envío a Meta real ni se usó navegador en esta entrega.

Resultado del 14-09-2026: builds de ambos repositorios correctos; 93 pruebas frontend; 509 unitarias backend; 20 suites / 376 casos de integración reportados (22 nuevos de líneas); 9 pruebas del artefacto de build. Los conteos financieros incluyen casos sin aserciones por Excel ausentes. Se comprobó además la migración sobre un historial ficticio previo: conserva mensaje y chat, asigna la línea comercial, conserva el acceso del agente y permite otro chat del mismo paciente en CLIMON.

## Incidente de despliegue del 14-09-2026

Vercel había publicado `ae4ddb8`, pero el VPS seguía en `e80fc9f`: faltaba `/lineas-whatsapp` y los chats no incluían `linea`. Esto produjo “No se pudieron cargar las líneas” y el TypeError al leer `linea.nombre`.

Se respaldó la base (`/root/backups-crm/crm-20260914-004058.sql.gz`, 3.599.151 bytes, `gzip -t` correcto), se desplegó `8ef88c1` y se aplicó `20260913120000_lineas_whatsapp_y_accesos`. Servicio activo y salud pública correctos; cuatro líneas registradas, 423 chats y 3.160 mensajes en ventas; dos agentes existentes con acceso comercial. La línea existente resuelve sus credenciales; las tres nuevas permanecen inactivas y sin conectar.

El frontend valida la identidad del canal antes de incorporar listado, detalle, paginación o resumen realtime. Un contrato incompleto presenta un error recuperable y no habilita el compositor. Los consumidores de recursos con error comprueban `hasValue()` antes de leer `value()`; el respaldo vuelve a pedir el catálogo si falló. Validación de la corrección: 98 pruebas frontend y build correctos, incluidas respuestas antiguas sin canal y recuperación al reintentar. No se enviaron mensajes a pacientes durante la verificación.
