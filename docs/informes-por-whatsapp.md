# Mis informes por WhatsApp

Estado: desplegado el 13/10/2026 en las líneas de prueba y Recepción, por petición de René. CRM `ed7f204`, API Resultados `1604ded`. Apagado por defecto en otras instalaciones. Sin envíos reales de prueba ni cambios de esquema propios de esta función. Respaldos y comprobaciones en [ESTADO_ACTUAL](ESTADO_ACTUAL.md).

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

No depende de Flows ni requiere publicar una plantilla. Una petición textual funciona también con el menú general apagado, siempre que la línea esté habilitada para informes. La consulta ocurre dentro de la ventana de atención existente de 24 horas. Los avisos manuales con plantilla y enlace del módulo Resultados siguen funcionando igual.

## Identidad y límites reales

- La identidad procede de la ficha asociada al teléfono del webhook firmado. El PAC debe existir en el CRM y coincidir exactamente en Resultados. El paciente y el modelo no pueden aportar un PAC, un CI ni un informe para elegir a otra persona.
- Si ambos sistemas tienen CI, un conflicto bloquea la consulta. No se intenta resolver por nombre, búsqueda aproximada o CI aislado. Sin PAC, el CRM pide el número de carnet (sin foto) y deriva a recepción con automatización pausada. El siguiente mensaje queda en el mismo chat para revisión; no cambia el CI/PAC de la ficha ni autoriza una descarga. Recepción verifica la identidad y vincula la ficha mediante las funciones que ya existen. Un fallo del portal no vuelve a pedir el carnet.
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

## Configuración y activación

En el CRM, `RESULTADOS_AUTOSERVICIO_LINEAS` contiene exclusivamente IDs explícitos de líneas permitidas, separados por coma. Vacío/ausente no habilita ninguna; `todas` no es un comodín. Además deben estar habilitadas las interacciones existentes en esa línea y la línea debe estar activa. En Resultados, `CRM_AUTOSERVICIO_INFORMES=on` habilita exclusivamente las dos rutas nuevas. El ejemplo queda en `off`.

En producción se habilitaron exclusivamente prueba y Recepción en la lista del CRM, y la API privada en Resultados. No se cambiaron números, WABAs, menús guardados, modelos de IA ni webhooks. El menú de Recepción sigue apagado; se pueden pedir informes por texto. La nueva opción se puede configurar desde el editor de menús, pero guardarla no habilita por sí sola la entrega clínica. Las promociones continúan restringidas a ventas.

La activación fue autorizada expresamente para prueba y Recepción. Se verificaron la credencial privada y conectividad existentes, y ambos recorridos con datos sintéticos en pruebas locales. No se envió un PDF por Meta a un teléfono real durante el despliegue. Antes de habilitar otras líneas, verificar sus permisos y las fichas; no asumir que un teléfono compartido identifica a todos sus usuarios.

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


## «Recibir PDF» desde el aviso

Desde el 27/10/2026 (código; se activa con la plantilla `montalvo_informe_pdf`,
ver [plantillas](plantillas-whatsapp.md#6-montalvo_informe_pdf--aviso-de-resultado-con-recibir-pdf)).
El aviso de resultado lleva dos botones: el enlace al portal, igual que antes, y
«Recibir PDF». Tocar el segundo manda el PDF de ese informe por el mismo
recorrido documental de arriba (pendiente durable, reclamo INCIERTO, subida a
Meta y revalidación antes de enviar).

```text
Aviso (plantilla del sistema, payload AVISO_INFORME_PDF en el botón)
  → Paciente toca «Recibir PDF»: webhook firmado, `type: button`, `context.id` = el aviso
  → El aviso es de ESTE chat (`AvisoResultado.mensajeId`); respuesta + documento en una transacción
  → Ficha del chat = ficha del aviso, mismo teléfono, PAC presente
  → Resultados lista el informe para ese PAC (publicado, acceso vigente, no revocado)
  → PDF original → Media API → documento `informe.pdf`
```

Diferencias con «Mis informes», a propósito:

- **No hay oferta cifrada.** El aviso vale lo que su enlace (30 días) y el
  detalle privado se purga a los 7, así que lo autoriza el aviso al que
  responde, que tiene que estar en esta conversación. El texto del botón no
  decide nada: solo distingue «Recibir PDF» de otro botón.
- **Una persona en el chat o la automatización pausada no lo frenan.** El
  paciente pide el informe del aviso que la clínica misma le mandó. Siguen
  frenándolo la línea sin autoservicio, el chat cerrado, el teléfono o la ficha
  cambiados y un informe que ya no está vigente para ese PAC.
- **Dos toques en 10 minutos mandan un PDF.** El segundo queda DUPLICADO, sin
  pedir a una persona. Pasado ese rato, otro toque lo vuelve a mandar.
- Si no puede salir (enlace vencido, informe retirado, PAC cambiado), el
  documento queda FALLIDO y el chat pasa a REVISIÓN: recepción usa «Renovar y
  enviar» o lo resuelve a mano.
- En una línea que no está en `RESULTADOS_AUTOSERVICIO_LINEAS` el toque no
  manda nada y lo ve una persona.

El aviso solo lleva el `payload` si la plantilla aprobada tiene botón de
respuesta rápida (`EnvioPlantillasService.enviarPlantillaDelSistema`): con
`montalvo_informe_disponible` sale exactamente como antes. Si el catálogo de
Meta no responde, sale sin `payload` y el toque se reconoce por el rótulo.

Pruebas: `aviso-informe-pdf.integracion.spec.ts` (webhook firmado y PostgreSQL
reales; Meta y Resultados simulados) y `aviso-informe-pdf.spec.ts`.

## Cola multítipo de Resultados (desplegada el 25/10/2026)

El módulo Angular y el backend admiten `tipo=ECOGRAFIA|PAPANICOLAU|LABORATORIO|OTRO`.
La omisión muestra todos los tipos. El CRM envía el filtro tanto al panorama como
al listado del portal antes de paginar, también en Por avisar/Esperando lectura.
Las filas incluyen `tipo`; solo una respuesta de portal anterior sin este campo
se interpreta como ecografía por compatibilidad con su contrato histórico.
Los contadores corresponden al tipo elegido, sin variar por el texto de búsqueda.

La pantalla conserva tipo, estado y búsqueda en la URL y vuelve a la página 1
al cambiar de filtro. El PAC queda visible aunque ya exista ficha. «Editar teléfono»
explica que cambia la ficha completa y muestra el valor actual. Un aviso sin mensaje
está «En proceso de envío»; un enlace vencido sin apertura se muestra vencido incluso
si WhatsApp entregó el aviso. No se ofrece un aviso nuevo si el paciente ya lo abrió.

El portal permite crear/listar estos tipos; su integración FileMaker usa una clave
única por tipo y referencia y rechaza identidades PAC/CI contradictorias. API y BD
siguen perteneciendo a Resultados, sin joins ni escritura cruzada desde CRM.

No se alteran roles ni línea de entrega, plantilla, automatizaciones o IA. Laboratorio
no pasa automáticamente a CLIMON. Los guiones de Papanicolau y laboratorio todavía
requieren los campos y la captura del módulo FileMaker que entregará René.

Orden de publicación: API Resultados y su migración primero; después CRM backend y
ambos frontends. **Desplegado así el 25/10/2026**: Resultados `4cb6ada`, CRM
`d22ef19`, Angular `7893a4e` (Vercel). En el servidor: panorama y listado
filtran por `tipo` (las 225 vigentes son ecografías; laboratorio, 0) y un tipo
desconocido devuelve 400. No se enviaron avisos ni se abrieron informes.
