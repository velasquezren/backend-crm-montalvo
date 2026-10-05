# Preparación local de interacciones oficiales — 2026-10-04

**Estado: SOLO LOCAL, DESACTIVADO.** No es una integración operativa de Flows.
No hay nuevos endpoints, transportes, asignaciones, persistencia ni automatismos.
La mensajería actual sigue usando exactamente sus controladores y servicios anteriores.
Los cambios previos ajenos a esta tarea se conservaron; no se hicieron commits, push ni despliegues.

## 1. Meta MCP y permisos comprobados

El servidor solicitado es [WhatsApp Business Tools MCP](https://developers.facebook.com/documentation/mcp/whatsapp-business-tools-mcp),
Streamable HTTP en `https://mcp.facebook.com/whatsapp_business_tools`, con OAuth.
La documentación lo describe como beta de despliegue gradual, con herramientas `whatsapp_biz_*`.
**No están disponibles en esta sesión.** No se instaló un sustituto comunitario ni se utilizaron credenciales del CRM.

Sí está conectado **Meta Social Technologies MCP** (`meta_developer_tools`), que es otro servidor oficial.
Se reutilizó su sesión autenticada únicamente con:

- `devtools_app_list(action=list)`: dos aplicaciones, sin más páginas.
- `devtools_webhook_list(action=list_subscriptions, app_id=1026204626700838)`.
- `devtools_discovery(action=search_docs)` para referencias oficiales actuales.

| Aplicación | App ID | Rol | Permiso concedido al MCP | Portafolio concedido |
|---|---|---|---|---|
| CRM Montalvo | `1026204626700838` | admin | read, manage; solo se usó lectura | No (`owning_business_granted=false`) |
| Nexus_Engine | `847512751074954` | admin | read, manage; no se inspeccionaron sus activos | No |

`owning_business_id=null` con ese indicador **no significa que no haya empresa**.
Tampoco el estado normal de la app acredita verificación empresarial.
No se llamó a herramientas de gestión, pruebas de webhook o envío.

Para completar el inventario falta habilitar el servidor específico y realizar su consentimiento OAuth
para el negocio y la app correctos. Los scopes documentados son `business_management`,
`whatsapp_business_management` y `whatsapp_business_messaging`; concederlos no autoriza a usar operaciones de escritura.
No se solicitaron contraseñas ni tokens, ni se modificó configuración local del cliente MCP.

## 2. Inventario remoto e histórico, sin confundirlos

**Remoto verificado hoy para CRM Montalvo:**

| Tema | Activo | Configuración devuelta |
|---|---|---|
| `whatsapp_business_account` | Sí | `messages`, `account_alerts`, `account_review_update`, `account_update`, `calls`, `message_template_quality_update`, `message_template_status_update`, `phone_number_name_update`, `phone_number_quality_update`, `security`; `include_values=true` |
| `user` | Sí | Sin campos; `include_values=false` |

Meta devuelve callbacks parcialmente ocultos: WhatsApp apunta al host CRM nuevo documentado;
`user` al host antiguo. No puede afirmarse la ruta completa con esa respuesta.
`user_preferences` y `flows` no aparecen en esta lista. El código sí atiende preferencias;
esta diferencia se documenta, **no se modifica la suscripción**.

**WABAs, números actuales, verificación, calidad y catálogo completo: NO VERIFICADOS hoy.**
Las referencias siguientes son históricas, no un inventario remoto actualizado:

| Referencia local | Evidencia | Límite |
|---|---|---|
| WABA `1011426071679964` | `docs/plantillas-whatsapp.md`, consulta registrada el 30/09 | No se reconsultó |
| Ventas y publicidad Montalvo | Migración `20260913120000_lineas_whatsapp_y_accesos`; comercial | Datos iniciales, no estado actual |
| Laboratorio CLIMON | Misma migración; no comercial | Número/activación actuales desconocidos |
| Recepción Clínica Montalvo Corporativo | Misma migración; no comercial | Número/activación actuales desconocidos |
| Centro Médico Montalvo | Misma migración; no comercial | Número/activación actuales desconocidos |

No se deduce activación actual del `false` inicial de una migración.
`docs/PANORAMA.md` describe cuatro líneas operativas, pero eso no reemplaza una consulta actual.

| Plantilla registrada en documentación | Estado histórico | Categoría/idioma verificables en esa evidencia |
|---|---|---|
| `montalvo_informe_disponible` | Aprobada, activa según nota del 24/09; revisada 30/09 | Categoría/idioma actuales desconocidos |
| `montalvo_recordatorio_cita` | Aprobada | Categoría/idioma actuales desconocidos |
| `montalvo_confirmacion_cita` | Aprobada | Categoría/idioma actuales desconocidos |
| `montalvo_seguimiento_solicitud_cita` | Aprobada | Categoría/idioma actuales desconocidos |
| `promo_especialidad`, `reactivacion_paciente`, `bienvenida_contacto` | Aprobadas, nota 30/09 | Marketing; idioma remoto no reconsultado |
| `reactivacion_con_foto` | Enviada a revisión el 30/09 | Marketing confirmado; borrador `es`; aprobación actual desconocida |
| `montalvo_informe_listo`, `montalvo_primer_contacto` | Propuestas locales en documento | Utility/es y Marketing/es respectivamente; no afirmar existencia remota |

## 3. Capacidades que ya soporta el CRM

| Capacidad | Código comprobado |
|---|---|
| Webhook único, firma Meta, resolución por `phone_number_id`, aislamiento por elemento y 503 en fallo transitorio | `src/modules/conversaciones/webhooks/whatsapp-webhook.controller.ts`, `MetaSignatureGuard` |
| Ingesta durable, deduplicación por índice `whatsappMsgId`, un chat por paciente/línea | `ingesta-whatsapp.service.ts`, `acceso-conversacion.ts`, `prisma/schema.prisma` |
| Texto/media, adjuntos durables, descarga y recuperación | `media-entrante.service.ts`, `TrabajoMediaEntrante` |
| Envío con `clientMessageId`, conciliación `biz_opaque_callback_data`, estado INCIERTO sin reenvío ciego | `conversaciones.service.ts`, `despachador-saliente.service.ts`, `reintento-saliente.service.ts` |
| Estados de entrega/lectura sin retroceder y errores permanentes | `procesarEstadoMensaje`, `common/whatsapp/error-envio.ts` |
| Plantillas por línea/WABA; variables NAMED/POSITIONAL, cabecera de imagen conocida, preview, URL dinámica en caminos específicos | `plantillas-whatsapp.ts`, `componentesPlantilla`, selector Angular |
| Quick replies de plantilla y botones/listas entrantes | DTO/webhook; actualmente extraen solamente texto visible |
| Respuestas rápidas y recursos personales | `plantillas-agente`, `memoria-agente`, compositor Angular |
| Roles, membresía de línea, atención compartida operativa y asignación comercial | `common/auth/roles.ts`, `whereAccesoConversacion`, `LineasWhatsappService` |
| Socket.IO, envío optimista reconciliado, reintento conservando UUID/adjunto | `ConversacionesGateway`, `ConversacionesStateService` |
| Acuse fuera de horario, ubicación y otras respuestas operativas preexistentes | `acuse-automatico.service.ts`, ingesta y locks existentes |
| Campañas con bajas/consentimiento operativo, ritmo y costo estimado por entregados | `modules/campanas`, `baja-promociones.ts` |

Las automatizaciones preexistentes no son IA y no se activaron ni cambiaron aquí.
No se reabrió la auditoría F01–F10 ni otros módulos terminados.

## 4. Capacidades faltantes y frontera de esta entrega

- La ingesta actual transforma respuestas en TEXTO y no persiste ID/estructura/contexto original.
- El DTO actual no modela `nfm_reply`, `context`, `timestamp` del mensaje ni `pricing` del status.
  `whitelist` los descarta; un Flow completado no entra hoy al historial.
- `Mensaje` no tiene un JSON para interacciones: el `metadata Json?` hallado en el esquema pertenece
  a otro modelo. **No sirve reutilizarlo ni guardar todo en `contenido`/`Cliente.datosExtra`.**
- El transporte admite un `Record<string, unknown>` interactivo y el acuse usa botones;
  falta validación general, snapshot durable para reconstruir reintentos y un compositor compatible.
- Plantillas Flow y quick replies con payload propio no están conectadas al despacho existente.
  El selector no constituye una validación completa de todos los tipos de botón de Meta.
- No hay catálogo de Flows ni tarifas/cuotas reales conciliadas para todas las líneas.

Se prepararon funciones puras y un componente aislado, **no se conectaron al webhook/historial real**.
La persistencia estructurada requerirá proponer y aprobar un cambio específico de esquema:
guardar en la misma transacción del mensaje la representación, versión y contexto necesarios.
Esta necesidad está demostrada por el modelo actual; no se generó ni ejecutó migración.
Cambiar una bandera hoy no completa esa integración: faltan esas conexiones explícitas.

## 5. Herramientas y bibliotecas evaluadas

| Herramienta | Mantenimiento/licencia/dependencias observables | Decisión |
|---|---|---|
| [Flow Builder y Flows API oficiales](https://developers.facebook.com/documentation/business-messaging/whatsapp/flows/guides/flowsapi/) | Producto Meta y términos de plataforma; no exige añadir biblioteca al CRM; valida activos y ofrece preview remoto | Preferencia para validación/publicación futura, con autorización |
| [WhatsApp Flow Studio](https://github.com/ANGELBERRIOS23/whatsapp-flow-studio) | MIT; autor declara un HTML sin dependencias; proyecto comunitario pequeño, sin garantía de compatibilidad continua. IA opcional usa proveedores y almacena claves en localStorage | No instalado ni abierto con datos del CRM; no necesario para dos borradores |
| [whatsapp-flows TypeScript/TSX](https://github.com/spookyuser/whatsapp-flows) | Repositorio consultado muestra 18 commits; core, runtime TSX y CLI con push remoto/Ajv. Licencia de distribución y árbol exacto de dependencias no corroborados | No instalado; añade compilador/router/sincronización innecesarios en esta fase |
| [Ajv](https://github.com/ajv-validator/ajv) | MIT, proyecto establecido; valida JSON Schema, no permisos/semántica remota de Meta; requiere esquema fiable y versión fijada | Evaluado; no añadido. El validador local limita el subconjunto que usamos |
| [WhatsApp-Flows-Tools](https://github.com/WhatsApp/WhatsApp-Flows-Tools) | Ejemplos oficiales MIT, no backend listo para clínica; muestras con versiones antiguas deben adaptarse | Referencia para protocolo, sin ejecutar ni copiar servidores |

No se actualizaron paquetes ni lockfiles. La validación local es propia y acotada,
**no un JSON Schema oficial completo ni certificación de aceptación por Meta**.

## 6. Recorridos y JSON borradores

| Recorrido preparado | Interacción | Final y límites |
|---|---|---|
| Bienvenida | Tres botones estables: `BOOK_APPOINTMENT`, `VIEW_SERVICES`, `TALK_TO_HUMAN` | Una oferta por contexto; texto libre y humano siempre posibles; no enviar marketing automático |
| Servicios/precios | Especialidad → búsqueda de servicio → consulta de precio/profesional → humano | Contratos sin conexión devuelven no disponible; nunca precio inventado |
| Cita | Especialidad → profesional → fecha preferida → horario preferido → nombre → resumen | `SOLICITUD_DE_CITA`, nunca confirmación ni bloqueo de cupo |
| Recepción | Lista de horario, ubicación, requisitos, orientación de informes y humano | Solo información administrativa aprobada; sin documentos/enlaces privados |
| Ventas | Promoción vigente validada → interés → contacto solicitado | Independiente de cita; contacto puntual no equivale a consentimiento de campañas |
| Humano | Solicitud explícita o asunto clínico/desconocido | Conserva chat/línea/responsable/mensaje/selección/motivo; sin asignador nuevo |

Archivos locales con versión explícita:

- [Solicitud v1](flows/solicitud-cita.v1.json): seis pantallas, una especialidad y profesional
  evidentemente DEMO; fecha elegida y franja preferida, no disponibilidad real. Sin CI, teléfono
  adicional, síntomas ni historia clínica. Nombre solo para probar con datos sintéticos.
- [Interés promocional v1](flows/interes-promocion.v1.json): flujo separado sin precio/descuento,
  consentimiento puntual visible, sin alta automática a campañas.
- [Manifest](flows/manifest.json): IDs/WABA nulos, desarrollo y producción separados,
  producción deshabilitada y validación Meta pendiente.

Flow JSON fijado en **7.3**, referenciado en el [changelog oficial](https://developers.facebook.com/documentation/business-messaging/whatsapp/flows/changelogs).
No se presupone su vigencia indefinida: revisar versiones soportadas/congeladas antes de crear el activo.
Los archivos están listos para revisión/versionado en Git, sin commit en esta entrega.

**Versiones remotas:** la [guía de ciclo de vida](https://developers.facebook.com/documentation/business-messaging/whatsapp/flows/guides/lifecycle/)
explica edición de Flows nuevos publicados, retorno a Draft y hasta cinco versiones;
algunos antiguos no admiten edición. Algunas secciones de Flows API aún describen inmutabilidad.
No afirmar que todos son inmutables ni que todos se pueden editar: verificar el activo.
Para una restauración futura: recuperar JSON revisado, crear un activo nuevo/clonado y registrar su nuevo ID
por ambiente; mantener correlaciones antiguas y pedir aprobación antes de cambiar el activo utilizado.
Una respuesta tardía puede llegar incluso de un Flow deprecado.

### Previsualización disponible y límites

`npm run check:flows` valida navegación, referencias, transporte de datos, campos, terminales y separación de ambientes.
El componente Angular `InteraccionPreviewComponent` representa mensajes/selecciones con fixtures en TestBed,
sin importar el componente desde una ruta o hilo reales. No es un emulador nativo de Flows.
No se generó URL de preview Meta: obtenerla requiere un activo remoto, cuya creación no está autorizada.
La aceptación visual/nativa queda pendiente del Builder oficial y dispositivos de prueba autorizados.

## 7. Mensajes y respuestas: contrato y conexiones pendientes

`src/common/whatsapp/interacciones/` contiene:

- `mensaje-interactivo.ts`: unión tipada, validadores, constructor de contenido Meta y componentes
  de botón para plantillas. No tiene destinatario ni cliente HTTP.
- `respuesta-interactiva.ts`: `button_reply`, `list_reply`, `template_reply`, `nfm_reply`, desconocidos,
  JSON inválido, snapshot original acotado y lectura de status/pricing/errores. Nunca ejecuta IDs.
- `preparacion-montalvo.ts`: IDs, mocks marcados DEMO, contratos y simulador **sin efectos**.
- `costo-interaccion.ts`: estimación con datos externos verificados; desconocido si falta tarifa.

Límites comprobados: [botones](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-reply-buttons-messages)
máximo 3, título 20, ID 256, cuerpo 1024, pie/cabecera textual 60;
[listas](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-list-messages)
10 filas totales, 10 secciones, títulos 24, ID 200, descripción 72, botón 20.
La referencia específica de listas consultada indica cuerpo 4096; no extrapolarlo a botones.
El subconjunto excluye media/productos. CTA Flow usa el máximo local conservador recomendado de 30 sin emoji;
el payload de quick reply de plantilla se acota localmente a 128, no afirma cubrir todas las variantes de Meta.

Un [mensaje Flow](https://developers.facebook.com/documentation/business-messaging/whatsapp/flows/guides/sendingaflow)
usa `interactive.type=flow`, `flow_message_version=3`, `flow_id`, `mode` explícito y
`navigate` o `data_exchange`. Solo `navigate` lleva `flow_action_payload`.
El botón de plantilla usa `sub_type=flow` y parámetro `action`; quick reply usa `sub_type=quick_reply`
y parámetro `payload`. Deben coincidir con índice, idioma, categoría y estructura de una plantilla **aprobada**.
Los constructores no verifican un catálogo remoto: esa comprobación sigue pendiente.

La [respuesta Flow](https://developers.facebook.com/documentation/business-messaging/whatsapp/flows/guides/flowswebhooks)
llega al webhook de mensajes existente como `nfm_reply.response_json`; **no incluye Flow ID**.
El `flow_token` se usa para correlación, no como autorización suficiente.
Se conserva estructura original separada de la proyección visible; nunca se expone el JSON arbitrario en Angular.

Conexión futura concreta, no ejecutada:

```text
Webhook existente → firma válida → parser antes del whitelist
  → resolver línea + correlación en servidor
  → ingesta existente + snapshot en MISMA transacción + whatsappMsgId único
  → proyección segura del historial → socket existente → componente Angular

Intención autorizada + clientMessageId estable → persistencia existente
  → despachador existente → Cloud API → statuses existentes
```

No tratar un desconocido como texto vacío ni rechazar todo un lote por un formato futuro.
Payload permanente inválido: registrar resultado técnico acotado y revisión, sin ejecutar acción;
fallo transitorio de persistencia: conservar 503/reintento. No inventar una segunda cola de memoria.
`mensajesVistos` del simulador **no reemplaza** el índice único de PostgreSQL.
INCIERTO nunca se reenvía por cuenta propia. Una correlación debe incluir chat, línea, persona,
mensaje original, opciones ofrecidas, activo/versión, vencimiento y consumo atómico.
Los títulos no son claves; ninguna regla nueva depende de etiquetas visibles.

## 8. Cambios locales realizados

| Lugar | Cambio |
|---|---|
| Backend `src/common/whatsapp/interacciones/` | Cinco archivos: cuatro módulos puros y suite sintética |
| Backend `docs/whatsapp-interacciones/` | Informe y dos JSON + manifest |
| Backend `scripts/validar-flows-locales.*` | Validador acotado y pruebas de mutación |
| Backend `package.json` | `check:flows` en build; `test:flows`; ninguna dependencia nueva |
| Backend `scripts/verificar-build.test.mjs` | Copiar los fixtures JSON al checkout temporal del test de build |
| Frontend `features/conversaciones/components/interaccion-preview/` | Componente OnPush con inputs signal, átomos existentes, referencias accesibles y seis tests |

Flag backend constante `INTERACCIONES_ACTIVADAS=false`; el código no se importa en servicios operativos.
Componente con `habilitada=false`, sin ruta ni inserción en conversación/compositor.
No cambió `schema.prisma`, DTO operativo, webhook, transporte, reintentos, permisos ni asignación.

## 9. Pruebas y validación

Ejecutadas sobre mocks/fixtures, sin base ni Meta de envío:

| Verificación | Resultado |
|---|---|
| Backend: mensajería, WhatsApp y conversaciones | 17 suites / 223 pruebas aprobadas, incluidas 47 nuevas |
| Frontend: conversaciones y líneas | 21 suites / 155 pruebas aprobadas, incluidas 6 nuevas |
| `npm run test:flows` | 5 aprobadas |
| `npm run build` en ambos repos | Aprobados |
| `npm run check:tests` en ambos repos | Aprobados |
| `npm run test:build` backend | 9 aprobadas: entrypoint, build limpio/consecutivo y fallo por no emisión |

Casos nuevos: recepción de botón/lista/Flow y quick reply; conservación de IDs/original;
JSON roto/desconocido/sobredimensionado; límites de Meta; opción no ofrecida; duplicado;
respuesta tardía; cerrado; toma de control humana; recepción compartida/comercial asignada;
Meta no disponible; límite de mensajes; ventana 24 h cerrada; precio/disponibilidad ausentes;
asunto clínico o desconocido; Flow no correlacionado; bienvenida no repetida; precio desconocido
en estimador; UI sin HTML ejecutable, sin envíos y desactivada por defecto.

La matriz de recepción/comercial prueba decisiones y conservación de contexto **en el simulador**,
no una nueva autorización de producción. Los índices/concurrencia de PostgreSQL conservan sus
pruebas existentes; no se ejecutaron suites de integración que crean/borran una base.
No se probó entrega real, validación remota Meta, facturación ni UI en dispositivo físico.

## 10. Costos y políticas — precisión sobre octubre de 2026

Se consultaron fuentes oficiales el 04/10/2026. El [anuncio específico de tarifas de mensajes no plantilla](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/non-template-messages)
establece cobro por mensaje de servicio y de utilidad dentro de CSW desde 01/10/2026.
La página general y [sitio comercial](https://whatsappbusiness.com/products/platform-pricing/)
todavía contienen afirmaciones de gratuidad. Se registra la discrepancia: no se convierte una
ventana de atención abierta en costo cero ni se altera una tarifa activa del CRM con esa ambigüedad.

| Tipo | Tratamiento preparado |
|---|---|
| Texto, botón, lista o apertura Flow sin plantilla | Servicio; exige ventana de atención abierta; no asumir gratuito |
| Plantilla Utility | Categoría aprobada, finalidad transaccional; tampoco presumir gratuidad por CSW |
| Plantilla Marketing | Promocional; aprobación y consentimiento/baja; costo según mercado/categoría |
| Authentication | Verificación OTP; no se usa para solicitudes de cita |
| Flow nativo | UI estructurada, no IA; su mensaje portador determina la categoría |
| Secuencia programada / futura IA externa | No vuelve gratuitos sus mensajes; IA externa tendría coste adicional propio |

CSW: 24 h desde último mensaje del usuario; fuera de ella, plantilla aprobada.
FEP documentado: entrada elegible desde anuncio Click-to-WhatsApp o CTA de página en Android/iOS,
respuesta dentro de 24 h y ventana de entrega gratuita de 72 h. La ventana FEP es independiente:
no habilita texto libre con CSW cerrada. Un enlace normal de WhatsApp no basta para acreditarla.
[Referencia de precios/FEP](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing).

**Importes exactos de octubre para los mercados de estas líneas y cuota gratuita restante: NO VERIFICADOS.**
No se fija una supuesta cuota de 1.000 a partir de fuentes secundarias ni se considera una cuota
desconocida como disponible. Tampoco se atribuye a Bolivia una tarifa sin revisar su rate card.
Marketing, utility y authentication requieren tarifa, moneda, mercado y vigencia; los tramos se verifican aparte.

`estimarCosto` recibe número empresarial, mercado del destinatario, categoría, CSW,
entrega, FEP corroborado, saldo de cuota corroborado y tarifa vigente. Devuelve `usd=null`
cuando no sabe y `facturacionReal=false` siempre. El consumo concurrente de cuota y su conciliación
mensual no están implementados; no llamar esta función como si descontara saldo.
Los estados `sent` no acreditan entrega facturable. El `pricing` del webhook indica categoría/cobrabilidad,
no el importe final; contrastar `pricing_analytics` y factura. Reintentos de estados no se suman dos veces.

Hoy Campañas estima `entregados × tarifaUsd` configurada para cada campaña; no es el costo global
de WhatsApp ni debe presentarse como factura Meta. No se modificó esa lógica.

Métricas mínimas futuras, sin dashboard ni nuevos datos persistidos ahora:

| Métrica | Definición y control |
|---|---|
| Mensajes por solicitud resuelta | IDs salientes distintos / solicitudes resueltas; null si denominador cero |
| Entregados | WAMIDs distintos con delivered/read; no contar callbacks repetidos |
| Costo estimado | Suma de tarifas válidas; informar cobertura/desconocidos por separado |
| Uso de botones/listas | Respuestas distintas por ID estable y mensaje original ofrecido |
| Uso de Flows | Aperturas vía analítica disponible; completados correlacionados por versión |
| Transferencias | Solicitudes únicas por motivo, sin texto clínico ni teléfono en métricas |
| Abandono | Estimación por inicio sin final dentro de TTL; no deducir abandono solo por falta de webhook |

## 11. Bloqueos

1. Falta WhatsApp Business Tools MCP y consentimiento del portafolio; inventario remoto incompleto.
2. Falta ampliación autorizada de persistencia de interacción/contexto y enlace con la tubería actual.
3. No hay API definitiva validada para servicios/precios/profesionales/disponibilidad/reservas.
4. Faltan rate cards efectivas y saldo de cuotas verificables para una estimación operativa.
5. Validación y preview oficiales pendientes de autorizar creación de borradores remotos.

## 12. Acciones exactas que necesitan autorización posterior

No se solicita ahora autorización para ejecutarlas; queda registrado el límite de esta fase.

1. Completar consentimiento OAuth del servidor oficial con negocio y app elegidos.
2. Crear **cada** borrador remoto, indicando WABA, nombre, versión/hash de JSON, categoría y ambiente;
   subir JSON y obtener preview sin publicar. Un preview local no autoriza un activo remoto.
3. Proponer la mínima migración de persistencia y su retención/acceso, revisión de transacciones y pruebas locales.
4. Conectar parser/DTO/ingesta/proyección al webhook existente, con bandera desactivada y
   pruebas reales de idempotencia/concurrencia en PostgreSQL descartable.
5. Implementar endpoint cifrado y validar API de catálogos; publicar endpoint y registrar clave pública
   solo con aprobación específica del destino/número/activo. No crear otro webhook de mensajes.
6. Publicar Flow o enviar plantilla a revisión, cada activo explícitamente identificado.
7. Enviar una prueba únicamente a un destinatario de prueba aprobado, identificando línea y mensaje.
8. Activar por línea o desplegar código: aprobación separada. Nada de esto autoriza IA automática.

## 13. Preparación para futura IA y endpoint dinámico

`HerramientasMontalvo` declara `consultarServicio`, `consultarPrecio`, `consultarEspecialidad`,
`consultarProfesional`, `consultarDisponibilidad`, `crearSolicitudCita`, `transferirHumano`.
Todas reciben contexto del servidor con conversación, línea, usuario y `clientMessageId`.
El adaptador sin conexión devuelve no disponible, incluso para escribir; no inventa IDs de éxito.
La futura IA solo propone llamadas a esas herramientas de Nest, nunca SQL ni acceso directo a FileMaker/ScriptCase.

Antes de ejecutar: sesión/capacidad/membresía de línea usando helpers actuales; correlación
chat/persona; esquema de argumentos cerrado; fuente vigente; límite de mensajes; consentimiento
si es promocional; control humano; auditoría técnica sin contenido clínico.
`accesoAutorizado` y `asunto` del simulador son entradas sintéticas: **no un reemplazo del guard ni un
clasificador médico**. Texto libre, desconocidos y cualquier consulta de síntomas/urgencias,
resultados, diagnóstico o tratamiento van a personal humano. No interpretar informes.
Transferencia futura reutiliza el servicio de conversación y sus permisos, sin alterar cartera/leads
ni robar una asignación existente. La respuesta conserva mensaje/selección para que el humano recupere contexto.

### Diseño del endpoint de intercambio — no implementado ni publicado

```text
Flow nativo → HTTPS POST cifrado → validación de firma y límites
 → descifrado → correlación autorizada → consulta administrativa autorizada
 → respuesta cifrada

Finalización → webhook de mensajes EXISTENTE → SOLICITUD_DE_CITA pendiente
```

Protocolo según [guía oficial](https://developers.facebook.com/documentation/business-messaging/whatsapp/flows/guides/implementingyourflowendpoint/):

- Sobre: `encrypted_flow_data`, `encrypted_aes_key`, `initial_vector` en base64.
- Verificar `X-Hub-Signature-256` sobre cuerpo crudo con secreto de app; limitar tamaño y validar
  base64 antes de descifrar. No registrar cuerpo ni excepciones que contengan datos.
- Clave RSA de 2048 bits administrada fuera del repo; OAEP SHA-256 para clave AES de 128 bits.
- AES-128-GCM; tag de autenticación de 16 bytes al final del ciphertext; IV de 16 bytes del sobre.
- Respuesta con misma clave AES y los bits del IV invertidos (`byte ^ 0xff`), ciphertext + tag,
  base64 como texto. No enviar JSON plano de respuesta ni reutilizar IV sin invertir.
- Error de descifrado: 421 según Meta. Probar firma inválida, GCM alterado, expiración/replay,
  límites y aislamiento antes de publicar. No generar ni subir claves en esta fase.
- `data_api_version=3.0` en la variante dinámica futura; `ping`, `INIT`, `BACK`, `data_exchange`
  y notificación de errores según protocolo. El borrador estático actual no declara ese endpoint.
- Estado/correlación opaco de vida corta ligado a línea, chat, persona, versión y solicitud;
  comprobar opciones contra catálogo del servidor y consumir el final de forma idempotente.
- Final de data exchange: pantalla `SUCCESS` con `data.extension_message_response.params`
  incluyendo correlación y referencia de solicitud, sin promesa de cita ni datos clínicos.
- Sin API disponible: estado de indisponibilidad y humano. No persistir una cita ni aceptar
  precio/horario enviado por el cliente como prueba de disponibilidad.

Guardar originales en el futuro exige acceso restringido, retención explícita y una proyección
separada para UI. `flow_token`, secretos, originales completos y datos clínicos no van a un LLM,
métricas ni logs. El preview actual solo admite texto y referencias seleccionadas, no payloads arbitrarios.

## 14. Qué NO se implementó

No hay IA/LLM, chatbot activo, motor genérico de automatizaciones, catálogo real nuevo,
Flow Builder propio, endpoint cifrado operativo, reserva confirmada, pagos, subida de comprobantes,
persistencia de interacciones, migración, ni conexión a ScriptCase/MySQL/FileMaker.
No se enviaron mensajes, crearon activos Meta, publicaron Flows/plantillas, tocaron números,
credenciales o webhooks. No se entró al VPS. No hubo push ni deploy.
La preparación es revisable y probada localmente; la operación real de Flows sigue pendiente.
