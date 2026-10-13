# Mis informes por WhatsApp

Estado: implementación local, apagada por defecto. Sin despliegue, sin envíos reales y sin cambios de esquema propios de esta función. Conserva los cambios de IA, notas de voz, promociones y agenda que estaban en el árbol de trabajo.

## Decisión: menú primero, IA como entrada opcional

No hace falta IA para consultar documentos. La opción **Mis informes**, de tipo `INFORMES`, y peticiones completas como «Mis informes» o «Quiero mis resultados» abren el mismo recorrido determinista. Gemini puede reconocer otras formas de pedirlos y solicitar `abrir_mis_informes()`, sin parámetros. No recibe títulos de estudios, identificadores ni PDFs de esta consulta. Interpretar un resultado, síntomas, tratamientos y urgencias sigue derivándose a una persona mediante el triaje existente.

La IA actual ya tiene modos SUGERIR y RESPONDER, herramientas con permisos por línea, triaje, transcripción de audios y agenda del médico. Se reutilizan; no se crea otro asistente. En SUGERIR, la agente ve «Abrir lista de informes»; en RESPONDER, el CRM abre la misma lista. Repetir la herramienta en un turno produce una sola acción. El texto inventado por el modelo no acompaña esta acción.

```text
Paciente: «Mis informes» / menú / intención reconocida por IA
  → CRM verifica línea, conversación y ficha
  → Resultados consulta PAC exacto, coherencia del CI y accesos vigentes
  → Lista nativa de WhatsApp (hasta 7 informes + navegación + recepción)
  → Paciente elige explícitamente «Recibir PDF»
  → Webhook existente: correlación y una intención documental en la misma transacción
  → Resultados revalida publicación, acceso y versión original del archivo
  → CRM sube bytes a Media API de Meta y obtiene media ID
  → CRM revalida ficha/publicación y envía documento mediante el despachador existente
  → Historial y estados existentes; nunca se marca el portal como «leído» por esta descarga
```

No depende de Flows ni requiere publicar una plantilla. La consulta ocurre dentro de la ventana de atención existente de 24 horas. Los avisos manuales con plantilla y enlace del módulo Resultados siguen funcionando igual.

## Identidad y límites reales

- La identidad procede de la ficha asociada al teléfono del webhook firmado. El PAC debe existir en el CRM y coincidir exactamente en Resultados. El paciente y el modelo no pueden aportar un PAC, un CI ni un informe para elegir a otra persona.
- Si ambos sistemas tienen CI, un conflicto bloquea la consulta. No se intenta resolver por nombre, búsqueda aproximada o CI aislado. Sin PAC, recepción revisa la ficha mediante las funciones que ya existen.
- **Esto prueba la asociación registrada teléfono–PAC, no la identidad civil de quien sostiene el teléfono.** Antes de habilitarlo, la clínica debe revisar ese vínculo. Un teléfono familiar, compartido, reasignado o con una ficha incorrecta requiere atención humana. No se implementa OTP, autenticación adicional ni acceso de tutores.
- La oferta queda cifrada y asociada a cliente, línea, conversación, teléfono, opciones, identificadores del informe y del archivo original. Caduca en 15 minutos y solo admite una selección. Para otro documento se abre otra lista.
- Correlación por mensaje Meta original, tipo de respuesta, opción ofrecida y vigencia. Los reintentos del webhook se deduplican. No se confía en el título devuelto por el teléfono.
- Solo se listan informes PUBLICADOS con archivo original y acceso vigente, no revocado. No se renuevan enlaces automáticamente. Un documento presente en la base puede no estar autorizado para entrega.
- Una corrección del PDF de FileMaker cambia `archivoId`: una selección anterior no sirve para el nuevo archivo. Se vuelve a consultar.
- Conversación cerrada, automatización pausada, atención tomada por una persona, línea inactiva/deshabilitada o identidad cambiada impiden el envío. Se revalida después de transferir el archivo a Meta.
- Dos sistemas y Meta no comparten transacción. Existe un intervalo entre la última comprobación y el envío; retirar después de entregar no recupera la copia en WhatsApp. No prometer revocación de un PDF ya enviado.

## Datos y privacidad

Resultados sigue siendo dueño de pacientes, informes, acceso y almacenamiento clínico. El CRM consulta su API privada por loopback, con la credencial existente. No comparte tablas, no consulta directamente FileMaker y no busca PDFs en el VPS de agenda.

El CRM transporta el PDF original en memoria, con tope de 10 MiB y tiempo máximo. Lo sube directamente a Meta; no crea una copia en R2 del CRM, archivo temporal ni URL pública. El nombre enviado es `informe.pdf`. Esta función sí transfiere el documento a WhatsApp, por petición expresa del paciente; la lista lo advierte. La copia recibida puede guardarse o reenviarse y no se puede retirar desde el portal.

Los agentes autorizados a esa conversación ven la lista, la selección y un registro documental; no reciben un enlace privilegiado al PDF desde el historial. Para revisar documentos clínicos se mantiene la autorización del módulo Resultados. La IA no recibe las interacciones marcadas `proposito: INFORMES` al construir su historial; tampoco recibe el cuerpo del PDF. Esto no elimina datos clínicos que un paciente escriba espontáneamente en otro mensaje.

La intención privada usa el cifrado y la purga existentes de `InteraccionMensaje`: detalle privado 7 días y proyección 30 días. El historial conserva el título seleccionado y la marca del documento según la retención general del CRM. No se añade otra política de borrado ni se afirma que todo desaparezca en 30 días. Resultados registra `PDF_PREPARADO_WHATSAPP`, no `abiertoEn`: preparar un archivo no prueba lectura ni entrega.

La subida a Meta crea un activo en ese proveedor. Si el envío se bloquea después de subir, puede quedar un activo sin mensaje; esta fase no añade un proceso de eliminación de activos remotos. No se almacena su ID para acceso público ni se incorpora al contexto del modelo.

## Fallos, persistencia y recuperación

La respuesta entrante, su correlación y el mensaje documental pendiente se guardan juntos. Si falla esa escritura, la transacción se revierte y Meta puede repetir el webhook sin consumir la oferta.

El documento nace FALLIDO, con `clientMessageId` estable y trabajo pendiente. Un despachador nuevo lo reconstruye desde PostgreSQL. Antes del primer efecto externo se reclama atómicamente como INCIERTO y se deshabilita el reintento. Una caída después de reclamar no provoca envíos ciegos. Los estados de Meta pueden reconciliar el envío por la referencia existente.

Un fallo de identidad, retirada, fuente o subida no entrega el documento y deja revisión humana. Un resultado incierto queda visible en el historial y no se reenvía. Para una nueva entrega se necesita una nueva selección válida; no se reutiliza indefinidamente una intención médica antigua. La consulta vacía informa de que no hay informes vigentes, sin decir que el paciente no tiene estudios.

## Configuración y activación pendiente

En el CRM, `RESULTADOS_AUTOSERVICIO_LINEAS` contiene exclusivamente IDs explícitos de líneas permitidas, separados por coma. Vacío/ausente no habilita ninguna; `todas` no es un comodín. Además deben estar habilitadas las interacciones existentes en esa línea y la línea debe estar activa. En Resultados, `CRM_AUTOSERVICIO_INFORMES=on` habilita exclusivamente las dos rutas nuevas. El ejemplo queda en `off`.

No se cambiaron variables del servidor, números, WABAs, menús guardados, modelos de IA ni webhooks. La nueva opción se puede configurar desde el editor de menús, pero guardarla no habilita por sí sola la entrega clínica. Las promociones continúan restringidas a ventas.

Antes de producción: revisar las fichas y la política de teléfonos compartidos; desplegar las versiones compatibles de ambos backends y Angular; verificar la credencial privada y conectividad existentes; habilitar ambos permisos solo para la línea de prueba; añadir «Mis informes» en su menú y recorrerlo con informes sintéticos. El envío real de un PDF sintético a un número de prueba y cualquier habilitación en recepción necesitan autorización explícita. Esta entrega no los ejecutó.

Apagar: vaciar la lista de líneas en el CRM y dejar `CRM_AUTOSERVICIO_INFORMES=off`. No elimina informes ni rompe los enlaces/plantillas existentes. Un PDF ya enviado a WhatsApp permanece con el destinatario.

## Archivos y contratos

- `modules/resultados/informes-chat.service.ts`: alcance de identidad, ofertas y selección.
- `modules/resultados/portal-resultados.client.ts` y `portal-resultados.module.ts`: cliente privado compartido sin dependencia circular con Conversaciones.
- `modules/conversaciones`: ingesta, correlación, despacho, contexto y acción del asistente; mismas tablas y mecanismos de transporte.
- `common/whatsapp/whatsapp-cloud.service.ts`: subida PDF mediante el cliente Meta existente.
- `modules/menu-atencion/menu-atencion.ts`: opción independiente `INFORMES`.
- Angular: editor del menú y sugerencia «Abrir lista de informes», con los componentes existentes.
- Resultados: `results/informes-chat.ts`, DTOs y dos rutas en `CrmIntegrationController`. Contrato en `docs/api.md` de ese repositorio. Ninguna ruta nueva se expone en el proxy público del portal.

## Verificación reproducible

Nunca cargar `.env` en las pruebas ni usar una base operativa. Crear un PostgreSQL descartable propio; aplicar las migraciones existentes a `crm_test` y `resultados_test` con variables explícitas. La función de informes no agrega ninguna migración.

```bash
# Backend CRM: la misma base crm_test local (:5433) que el resto de las suites; nunca DATABASE_URL.
npm run test:integracion:preparar && \
  npx jest --runInBand --testPathIgnorePatterns '/node_modules/' --testPathPattern informes-chat.integracion
npm run check:tests
npm test -- --runInBand
npm run build
# Backend Resultados: solo loopback y base resultados_test.
TEST_RESULTADOS_DATABASE_URL=postgresql://crm_app@127.0.0.1:55439/resultados_test npm run test:integration
npm test
# Angular
npm run check:tests
npm test -- --watch=false
npm run build
```

La suite CRM usa webhook HTTP firmado, ingesta y PostgreSQL reales; solo simula Resultados y Meta. La suite Resultados usa HTTP, PostgreSQL, PDF sintético y almacenamiento local reales. No es una prueba real contra Meta ni una prueba de carga. Se cubren selección, deduplicación concurrente, rollback transaccional inducido dentro de PostgreSQL, reconstrucción por un despachador nuevo, identidad, líneas, atención humana, incertidumbre, revocación, vencimiento y paginación.

Referencias oficiales consultadas: [Media API](https://www.postman.com/meta/whatsapp-business-platform/folder/13382743-ecb27be5-4d27-4763-bbee-6a8002c04bf3) y [documento por media ID](https://www.postman.com/meta/whatsapp-business-platform/request/zjtbdpz/send-document-message-by-id). El límite de 10 MiB es del dominio de Resultados, no una afirmación del límite general de WhatsApp.

### Resultado local de la validación (13/10/2026)

- CRM: 99 suites y 1.165 pruebas unitarias aprobadas; 18 pruebas de integración de informes con PostgreSQL descartable aprobadas. La suite histórica del clasificador avisa que no dispone de sus fixtures de enero; no se usaron datos personales para suplirlos.
- Angular: 97 archivos y 765 pruebas aprobadas; comprobación de tipos y build de producción aprobados.
- Resultados: 22 pruebas unitarias y 54 de integración HTTP/PostgreSQL aprobadas, incluidas las de adjuntos existentes.
- CRM: build, coherencia de skills, validación local de Flows y tipos de pruebas aprobados.
- Base de pruebas aislada en puerto 55439; no se reutilizó ni reinició el PostgreSQL que ya estaba en 5433. Migraciones únicamente en las bases descartables.
- Meta y la IA se simularon. No hubo despliegue, push, mensajes reales, lectura de PDFs clínicos, cambios de configuración de producción ni prueba de carga.
