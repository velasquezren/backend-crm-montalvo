# CAMP-0 — ¿REALMENTE VALEN LA PENA NUESTRAS CAMPAÑAS?

**Primera entrega: diagnóstico solamente.** Esta revisión no modifica código,
schema, campañas, presupuesto ni suscripciones, y no envía eventos a Meta.

Fecha de revisión: 17–18 de septiembre de 2026.

## Resultado ejecutivo

La atribución de Click-to-WhatsApp ya está implementada en el backend. El
webhook modela `referral`, extrae `source_id` y `ctwa_clid`, y la ingesta guarda
el anuncio en tres lugares relacionados: `Lead.anuncioId`,
`PrimerContactoWhatsapp.anuncioId` y `Cliente.datosExtra.campanaOrigen`.

La unión anuncio → conversación → cliente es demostrable cuando el mensaje
entrante trae `referral.source_id`. La unión cliente → venta es demostrable
solo si la venta tiene `Venta.leadId`; el vínculo es opcional y las ventas
históricas o presenciales pueden no tenerlo. Por eso todavía no se puede afirmar
un ROAS por campaña para todas las ventas.

El MCP de Meta permitió inspeccionar la app y sus webhooks, pero en esta sesión
no proporcionó una operación de Marketing API/Graph para listar ad accounts,
campaigns, ad sets, ads, creatives o Insights. No hay inventario ni gasto real
que reportar desde el MCP: cualquier cantidad sería inventada. La app “CRM
Montalvo” (`1026204626700838`) aparece con rol `admin` y permisos del MCP
`read, manage`; sus privilegios de revisión devuelven una lista vacía. La
suscripción real incluye `whatsapp_business_account.messages` y una suscripción
`user`; no aparece una suscripción `page.messaging_referrals`.

La documentación oficial consultada por el MCP confirma que Insights expone la
capa publicitaria y que Conversions API para Business Messaging usa
`ctwa_clid`, `waba_id` y `dataset_id`. Eso demuestra que el ciclo es posible,
pero no que las credenciales actuales tengan acceso a esos activos.

## Campañas reales encontradas

No fue posible obtener campañas reales, estados, fechas, ad sets, anuncios,
creatives, gasto, impresiones, alcance, clics ni acciones con las herramientas
disponibles en esta sesión.

Lo comprobado:

| Comprobación | Resultado |
| --- | --- |
| App Meta visible | Sí: “CRM Montalvo”, ID `1026204626700838` |
| Rol MCP | `admin` |
| Permisos MCP | `read`, `manage` |
| Privilegios Meta revisables | lista vacía |
| Endpoint/operación Marketing API en el MCP | No expuesto |
| Campañas y gasto | No determinables todavía |

La siguiente fase de acceso debe disponer de un token con Marketing API y de los
IDs de Business/ad account. Será lectura únicamente y deberá consultar la
jerarquía `ad account → campaign → ad set → ad → creative` y `/{ad-account-id}/insights`.

## Qué ofrece Meta MCP actualmente

El MCP permitió:

- listar las apps Meta accesibles;
- inspeccionar configuración avanzada y privilegios de la app;
- listar topics de webhook y suscripciones activas;
- buscar documentación oficial de Marketing API, Insights, Click-to-WhatsApp y
  Conversions API.

El MCP no permitió:

- descubrir cuentas publicitarias asignadas;
- ejecutar Graph API arbitrario;
- consultar campañas, ad sets, ads, creatives o Insights;
- leer gasto o métricas por rango de fechas;
- consultar datasets de Conversions API.

La suscripción actual de WhatsApp tiene estos campos relevantes: `messages` y
varios avisos de cuenta/calidad/plantillas. El topic `page` ofrece
`messaging_referrals`, pero no está suscrito en la app inspeccionada. La
ausencia de ese topic no impide el referral de Click-to-WhatsApp que llega
dentro del mensaje de WhatsApp; son superficies distintas.

## Qué información referral recibe el backend

El DTO `WhatsappReferralDto` acepta:

`source_url`, `source_type`, `source_id`, `headline`, `body`, `media_type`,
`image_url`, `video_url`, `thumbnail_url`, `ctwa_clid` y
`welcome_message.text`.

`WhatsappWebhookController.extraerReferral()` normaliza esos campos. Para
videos conserva también `thumbnail_url` cuando no hay `image_url`. Después
`procesarMensaje()` pasa el referral a `IngestaWhatsappService.procesarEntrante()`.

La recepción es compatible con Click-to-WhatsApp. También existe el webhook
separado de Lead Ads, que resuelve `leadgen_id` contra Graph y recibe `ad_id`.

## Qué guardamos y qué descartamos

### Persistido de forma estructurada

- `Lead.anuncioId`: el `source_id` del anuncio CTWA o el `ad_id` resuelto para
  Lead Ads.
- `Lead.origen`: `FACEBOOK_LEAD_AD`, `INSTAGRAM_LEAD_AD` o
  `WHATSAPP_DIRECTO`.
- `PrimerContactoWhatsapp.anuncioId`: el anuncio que originó el primer contacto
  durable.
- `Cliente.datosExtra.campanaOrigen`: JSON con `titular`, `anuncioId`, `cuerpo`,
  `origenUrl`, `imagenUrl`, `mediaTipo`, `videoUrl`, `saludo`, `clickId` y
  `fecha`.
- `Interes`: se crea con el titular del anuncio cuando la línea es comercial.
- `Mensaje`: conserva el mensaje entrante, su conversación, timestamp e ID de
  WhatsApp, pero no una columna referral propia.

`ctwa_clid` sí se guarda en `datosExtra.campanaOrigen.clickId`. Es el dato clave
para una futura Conversions API; solo llega en el webhook y no puede reconstruirse
de forma fiable después.

### No hay evidencia de persistencia histórica separada

No existe una tabla de atribución, touchpoints, campañas, ad sets, ads,
creatives, gasto o snapshot de Insights. Tampoco hay una consulta histórica que
extraiga referrals desde logs. Los logs registran errores y conteos operativos,
no un archivo durable de payloads completos.

## Mapa anuncio → conversación → cliente → venta

```text
WhatsApp message.referral.source_id
        │
        ├── PrimerContactoWhatsapp.anuncioId ← Mensaje.id
        ├── Lead.anuncioId ← Lead.clienteId
        └── Cliente.datosExtra.campanaOrigen
                │
                ├── Conversacion.clienteId
                └── Venta.clienteId + opcional Venta.leadId
```

La conversación tiene una fila por `(clienteId, lineaId)`. Una paciente puede
tener varias conversaciones si usa líneas distintas, y una misma conversación
puede recibir más de un referral a lo largo del tiempo. El JSON de cliente se
actualiza con el último referral, por lo que no debe ser la única fuente para un
modelo multi-touch.

## Cuánto histórico podemos reconstruir

Hay cuatro casos:

**A — referral persistido.** Para mensajes recibidos desde la versión que ya
guarda `anuncioId` y `clickId`, se puede reconstruir el vínculo a cliente,
conversación y primer contacto. Es el caso actual para los registros que tienen
esos campos.

**B — referral solo en logs/webhooks históricos.** No se encontró un archivo
durable de payloads ni una tabla de raw webhooks. Solo sería recuperable desde
backups o logs externos que no están disponibles en este diagnóstico.

**C — referral recibido y descartado.** En versiones anteriores el DTO podía
descartarlo por whitelist; esos eventos no pueden distinguirse de un WhatsApp
directo ahora. La atribución fiable empieza en el primer mensaje que dejó
`anuncioId`/`clickId`.

**D — campañas que no son CTWA.** Para Lead Ads de formulario se usa el webhook
`leadgen`, Graph resuelve `ad_id` y se guarda en `Lead.anuncioId`. Para anuncios
que llevan a web, Instagram u otro destino no hay vínculo automático con una
conversación WhatsApp: hace falta el mecanismo de tracking correspondiente (por
ejemplo, UTMs y un identificador capturado en el sitio) o aceptar que no son
atribuibles a WhatsApp.

## Mapa de datos del CRM

| Entidad | Campos de relación relevantes |
| --- | --- |
| `Mensaje` | `id`, `conversacionId`, `direccion`, `createdAt`, `whatsappMsgId`, `contenido` |
| `Conversacion` | `id`, `clienteId`, `lineaId`, `createdAt`, `updatedAt` |
| `Cliente` | `id`, `telefono`, `pac`, `createdAt`, `datosExtra` JSON |
| `Lead` | `id`, `clienteId`, `origen`, `estado`, `anuncioId`, `createdAt` |
| `PrimerContactoWhatsapp` | `mensajeId`, `conversacionId`, `origen`, `anuncioId`, `createdAt` |
| `Venta` | `id`, `clienteId`, `leadId?`, `producto`, `monto`, `estado`, `createdAt` |
| `VentaImportada` | `pac`, `fecha`, `precio`, `anticipoPlan`, `ingresoNeto`, `canal`, `comisionable` |

Una venta se puede atribuir inequívocamente al cliente por `Venta.clienteId`.
Se puede atribuir inequívocamente a un lead/anuncio solo si `Venta.leadId` está
relleno y ese lead tiene `anuncioId`. `Venta` no tiene `conversacionId`; el
vínculo a conversación siempre sería indirecto por cliente y línea.

`VentaImportada` se cruza con el paciente mediante `Cliente.pac` ↔
`VentaImportada.pac`, pero no tiene `leadId`, `anuncioId` ni conversación. Sirve
para ingresos/servicios históricos y comisiones, no para atribución directa de
campaña sin una regla adicional y explícita.

## Qué significa “venta” e ingreso real

La entidad operativa `Venta` representa una venta manual con monto en Bs,
producto, cliente, agente y estado `GANADA` o `PERDIDA`; el estado puede cambiar
y `comentario`/campos de comprobante aportan contexto. El importe atribuible
debe sumar solo ventas `GANADA`, con una política explícita para anulaciones y
reversiones. No hay una columna de devolución separada en `Venta`.

`VentaImportada` representa filas de servicios importadas desde FileMaker/Excel.
Su `precio` es el precio del plan; `ingresoNeto` es una derivación para
comisiones (`precio × 0,87`), no necesariamente caja cobrada. `anticipoPlan` es
un dato distinto. Por ello “ingreso real” debe definirse antes del dashboard:
ventas CRM ganadas, precio de servicio importado, anticipo cobrado o una medida
financiera nueva no son equivalentes.

## Métricas calculables hoy

### Desde Meta, si se habilita Marketing API de solo lectura

Gasto, impresiones, alcance, clics, acciones, CPM/CPC/CTR, resultados y estados
por campaña, ad set y anuncio; también nombres, IDs y fechas de los objetos.
Hoy no podemos obtenerlas por el límite del MCP descrito arriba.

### Desde el CRM

Con atribución directa por `Lead.anuncioId` se pueden calcular conversaciones
con referral, leads nuevos, leads por estado, clientes, ventas con `leadId`,
importe de `Venta.monto`, conversión lead→venta, conversación→lead y
lead→venta. También se puede medir primera respuesta y tiempo lead→venta con
`Mensaje.createdAt`, `PrimerContactoWhatsapp.createdAt`, `Lead.createdAt` y
`Venta.createdAt`.

CAC, costo por lead, costo por conversación, ticket promedio y ROAS requieren
combinar gasto Meta con la misma cohorte y una definición de venta/ingreso.

## Métricas que requieren cambios o decisiones

- histórico de cada touchpoint/referral, no solo el último JSON en `Cliente`;
- modelo de campaña/ad set/ad/creative y snapshots diarios de Insights;
- vínculo explícito de cada conversación o lead a su touchpoint primario;
- política de deduplicación para una paciente existente y varios anuncios;
- estado financiero y anulaciones para ingreso neto real;
- definición de ventana de atribución (por ejemplo 7/30/90 días);
- permiso y dataset para Conversions API;
- captura de UTMs para anuncios que no son CTWA.

## Posibilidad real de ROAS y CAC

**ROAS por anuncio/campaña:** posible para el subconjunto con gasto de Meta,
`source_id`/`ctwa_clid` y una venta claramente enlazada. No es completo ni
defendible para todo el histórico actual.

**CAC:** posible con la misma restricción; debe distinguir paciente nuevo de
paciente ya existente. Dividir gasto entre todos los leads sin esa distinción
produciría un CAC engañoso.

La atribución recomendada para la primera versión es conservadora:

```text
primer mensaje entrante con referral.source_id
→ primer contacto durable
→ lead creado/convertido para ese cliente
→ Venta.leadId explícito
→ venta GANADA dentro de la ventana definida
```

Si hay dos anuncios, se informa primero el anuncio del primer referral como
atribución primaria y se conserva el resto como touchpoints; no se reparte el
100 % del ingreso entre anuncios sin una regla aprobada.

## Conversions API para CRM

La documentación obtenida por el MCP confirma el flujo para Business Messaging:
enviar eventos con `dataset_id`, `waba_id`, access token y `ctwa_clid`; un evento
de compra puede incluir `event_name`, `event_time`, `action_source=
business_messaging`, `messaging_channel=whatsapp` y valor/moneda.

La app actual no expone privilegios de revisión y el MCP no confirmó dataset,
ad account, permisos Marketing API ni `dataset_id`. Por tanto la posibilidad es
**técnicamente viable, operativamente no verificada**. No se envió ningún evento.

Eventos mínimos futuros:

- `Lead`: `ctwa_clid`, WABA, timestamp y un identificador interno no reversible;
- `QualifiedLead`: los mismos identificadores y timestamp;
- `Purchase`: `ctwa_clid`, timestamp, moneda y valor agregado.

No enviar conversaciones, nombres, teléfonos, diagnósticos, tratamientos,
notas clínicas, fotografías ni `pac`. La identificación debe usar el dato mínimo
necesario y respetar consentimiento, retención y controles de acceso.

## Diseño conceptual del dashboard futuro

**Resumen:** gasto Meta, ingresos atribuibles, ROAS, leads, ventas y CAC, siempre
con etiqueta de cobertura (“atribución directa”, “inferida” o “sin vínculo”).

**Campañas:** campaña, gasto, conversaciones CTWA, leads nuevos, calificados,
clientes, ventas, ingresos, CAC, ROAS y ventana de atribución.

**Funnel:** impresiones → clics → conversaciones → leads → calificados → ventas.
Las primeras dos etapas vienen de Meta; el resto del CRM.

**Creativos/anuncios:** conversaciones, ventas y ROAS solo cuando exista
`source_id`; mostrar también volumen no atribuible para evitar conclusiones
optimistas.

**Alerta factual:** “muchos leads, pocas ventas” y “menos leads, más ingresos”,
con tamaños de muestra y ventana visibles. No pausar ni modificar campañas
automáticamente.

## Cambios mínimos necesarios para construirlo

1. Habilitar una lectura segura de Marketing API y registrar IDs de ad account,
   campañas, ads y dataset sin guardar tokens en el CRM.
2. Crear un registro append-only de touchpoints/referrals con `ctwa_clid`,
   `source_id`, cliente, conversación, mensaje y timestamp.
3. Mantener `Lead.anuncioId` y exigir/registrar el `leadId` al cerrar una venta
   cuando provenga del pipeline.
4. Definir ingreso atribuible, anulaciones y ventanas de atribución.
5. Capturar UTMs o identificadores para destinos que no sean CTWA.
6. Añadir un proceso de snapshots de Insights por día, con zona horaria y moneda.
7. Solo después, construir agregados y la pantalla.

## Riesgos de atribución

- El último referral en `Cliente.datosExtra` no representa todos los contactos.
- Una paciente preexistente puede parecer un lead nuevo si no se separan cohortes.
- Una venta puede ocurrir meses después o por una influencia presencial.
- `VentaImportada` no contiene vínculo de marketing.
- La ausencia de `leadId` no demuestra que no hubo influencia de campaña.
- `source_id` identifica el anuncio, no por sí solo la campaña; hace falta
  resolver la jerarquía en Meta y conservar snapshots.
- Cambios de nombre/estado en Meta requieren IDs y fechas, no nombres actuales.
- Un ROAS con ingreso bruto y otro con ingreso neto pueden contar historias
  opuestas.

## Recomendación por fases

**Fase 0 — acceso y contrato.** Obtener acceso de solo lectura a Marketing API,
ad account(s), Insights y dataset; validar permisos sin modificar objetos.

**Fase 1 — atribución durable.** Convertir el referral actual en touchpoints
append-only, mantener `ctwa_clid`, y cerrar la regla de `Venta.leadId`.

**Fase 2 — datos publicitarios.** Importar snapshots diarios de campaña/ad set/ad,
spend, delivery e Insights; resolver nombres solo como datos de presentación.

**Fase 3 — conciliación.** Definir ingreso, anulaciones, ventanas y cohortes;
comparar atribución directa con métricas inferidas y marcar incertidumbre.

**Fase 4 — dashboard.** Resumen, campañas, funnel, creativos y alertas
informativas, sin automatizar pausas ni presupuesto.

**Fase 5 — señal de optimización.** Solo tras consentimiento, revisión de
privacidad y prueba de dataset, evaluar `Lead`, `QualifiedLead` y `Purchase` por
Conversions API. Esta fase no se inició.

## Fuentes y límites

- Código revisado: `whatsapp-webhook.dto.ts`,
  `whatsapp-webhook.controller.ts`, `ingesta-whatsapp.service.ts`, webhook de
  Lead Ads, `schema.prisma` y `ventas.service.ts`.
- MCP Meta: app list, app privileges, webhook topics/subscriptions y búsqueda
  de documentación oficial.
- No se inspeccionaron ni expusieron tokens, secretos, conversaciones reales ni
  datos de pacientes.
- No se cambió código ni schema, no se modificaron campañas y no se enviaron
  eventos.
