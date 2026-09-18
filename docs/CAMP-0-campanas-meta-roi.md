# CAMP-0 — ¿REALMENTE VALEN LA PENA NUESTRAS CAMPAÑAS?

**Primera entrega: diagnóstico solamente.** Esta revisión no modifica código,
schema, campañas, presupuesto ni suscripciones, y no envía eventos a Meta.

Fecha de revisión: 17–18 de septiembre de 2026.

**Continuación CAMP-1–15:** 17/09/2026 por la noche, America/La_Paz
(18/09 UTC), sobre backend `39fd18b`. Se conserva y precisa la primera entrega.
La continuación y la **CONCLUSIÓN EJECUTIVA** al final contienen la evidencia
vigente. No se consultó el VPS; R3 permanece pausado. No se hizo push.

## Resultado ejecutivo

La captura parcial del origen Click-to-WhatsApp está implementada en el backend. El
webhook modela `referral`, extrae `source_id` y `ctwa_clid`, y la ingesta guarda
el anuncio en tres lugares relacionados: `Lead.anuncioId`,
`PrimerContactoWhatsapp.anuncioId` y `Cliente.datosExtra.campanaOrigen`.

La cadena mensaje → conversación → primer contacto → lead puede demostrarse
cuando existe la reserva durable enlazada. Cliente → venta siempre tiene FK
por `Venta.clienteId`; `Venta.leadId` agrega el vínculo opcional a una oportunidad
concreta. Un ID de origen no demuestra por sí solo que sea un anuncio ni que
haya causado una venta. No hay todavía ROAS medido.

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
pero no que las credenciales actuales tengan acceso a esos activos. La
continuación comprobó por Graph un token válido con `ads_read` y
`whatsapp_business_manage_events`, pero cero cuentas/portfolios enumerados.
No faltan necesariamente scopes: falta demostrar acceso a la cuenta concreta.

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

`ctwa_clid` puede guardarse en `datosExtra.campanaOrigen.clickId`, en líneas
comerciales y bajo la condición descrita en CAMP-4. Es una foto sobrescribible,
no una relación durable con el lead o la venta.

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

**A — referral persistido parcialmente.** `anuncioId` en primer contacto enlazado
permite recorrer su mensaje/conversación/lead. El JSON del cliente, por sí solo,
no demuestra qué mensaje ni qué lead correspondían al clic. No se midió cuántos
registros de producción cumplen cada condición.

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
producto, cliente, agente y estado `GANADA`, `EN_PROCESO` o `PERDIDA`; el estado puede cambiar
y `notas`, `motivoPerdida` y campos de comprobante aportan contexto. El importe atribuible
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

Los costos de adquisición/contacto y ROAS requieren gasto Meta. El ticket
promedio de ventas GANADA puede calcularse sin gasto. Las duraciones actuales
miden registro en CRM; no necesariamente clic, cierre comercial ni cobro.

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

Hipótesis inicial de eventos, **no un contrato validado ni autorización de envío
sanitario**; CAMP-14–15 distingue CTWA de formularios y revisa esta propuesta:

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
- `source_id` debe interpretarse con su tipo. El CRM pierde `source_type`; hace
  falta verificar la entidad y resolver la jerarquía en Meta antes de llamarlo
  anuncio/campaña confirmado.
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

## Continuación CAMP-1–15: evidencia y límites de la medición

Esta continuación distingue **capacidad del código**, **presencia real en datos**
y **atribución comercial**. Una FK prueba una relación registrada; no prueba
incrementalidad ni que la publicidad causara la compra.

Evidencia nueva, sin repetir las consultas MCP de la primera entrega:

- Backend revisado: `39fd18b`; cambios actuales limitados a este informe.
- Base configurada: PostgreSQL local `localhost:5432/crm`. Se intentó conectar
  con `default_transaction_read_only=on`: **ECONNREFUSED**.
- No hay listeners locales de PostgreSQL en 5432/5433 ni socket visible en
  `/var/run/postgresql`. No se halló copia SQL/dump ni payload histórico JSON
  con los patrones buscados en los repositorios. Esto no prueba que no exista
  un respaldo fuera de este espacio de trabajo.
- No se inició servidor, restauración ni seed. No se usaron fixtures como datos
  de negocio. No se accedió por SSH al VPS.
- Graph API sí respondió consultas GET con una credencial local de la app.
  Se describen sus resultados en CAMP-10, sin publicar ningún token.
- Consultas reproducibles preparadas en
  [SQL temporal de investigación](/tmp/camp-atribucion-solo-lectura.sql):
  transacción `REPEATABLE READ READ ONLY`, límites de tiempo, solo agregados y
  `ROLLBACK`. **No ejecutadas contra datos: la base no está disponible.**
  El archivo está fuera de Git y no se debe commitear.

### CAMP-1 — Mapa exacto, cardinalidad y pérdidas posibles

Referencias:
[schema Prisma](../prisma/schema.prisma),
[ingesta](../src/modules/conversaciones/ingesta-whatsapp.service.ts),
[primer contacto](../src/modules/leads/primer-contacto.service.ts) y
[ventas](../src/modules/ventas/ventas.service.ts).

```text
referral.source_id                     referral.ctwa_clid
        │                                      │
        ├── PrimerContactoWhatsapp.anuncioId    └── Cliente.datosExtra
        │       │                                  .campanaOrigen.clickId
        │       ├── mensajeId → Mensaje              (foto actual, reemplazable)
        │       ├── conversacionId → Conversacion → Cliente
        │       └── leadId → Lead.anuncioId
        │                       │
        └── JSON del Cliente    └── Venta.leadId → Venta.monto/estado
                                                    │
                                                Venta.clienteId → Cliente
```

| Salto real | Modelo/campo y FK | Cardinalidad y nulabilidad | Cómo se pierde o limita |
| --- | --- | --- | --- |
| Referral → origen | `source_id` → `ReferenciaCampana.anuncioId` → `PrimerContactoWhatsapp.anuncioId` / `Lead.anuncioId` | Strings opcionales; sin FK a Meta; un origen puede aparecer en muchos leads | Falta referral; ID sin tipo; línea no comercial; primer mensaje sin anuncio; no existe catálogo Meta |
| Mensaje → conversación | `Mensaje.conversacionId → Conversacion.id` | N:1; obligatorio | Al borrar conversación se borran mensajes por CASCADE |
| Conversación → cliente | `Conversacion.clienteId → Cliente.id` | N:1 obligatorio; UNIQUE `(clienteId,lineaId)` | Un hilo se reutiliza durante meses; no representa una sesión ni una visita |
| Mensaje → primer contacto | `PrimerContactoWhatsapp.mensajeId → Mensaje.id` | UNIQUE nullable; un mensaje tiene 0..1 primer contacto; reserva inicialmente sin mensaje | Solo se fija el primer mensaje confirmado; borrar ese mensaje borra la reserva por CASCADE |
| Conversación → primer contacto | `PrimerContactoWhatsapp.conversacionId → Conversacion.id` | PK y FK no nullable; conversación tiene 0..1 reserva | Solo al crear una conversación comercial en esta versión; migración sin backfill; borrar conversación borra reserva |
| Primer contacto → lead | `PrimerContactoWhatsapp.leadId → Lead.id` | UNIQUE nullable: 0..1 hasta que el worker confirme el alta; cada lead tiene 0..1 reserva | Alta pendiente/reintentando; borrar lead borra reserva por CASCADE |
| Lead → cliente | `Lead.clienteId → Cliente.id` | N:1 obligatorio; un cliente puede tener muchos leads | Borrado de cliente propaga CASCADE si otras FKs no lo impiden |
| Venta → lead | `Venta.leadId → Lead.id` | N:0..1, nullable; un lead puede originar varias ventas | Opcional al registrar; borrar lead hace SET NULL; no impone selección correcta por negocio |
| Venta → cliente | `Venta.clienteId → Cliente.id` | N:1 obligatorio; eliminación de cliente RESTRICT | Siempre identifica cliente, no anuncio; backend valida que el lead elegido pertenezca al mismo cliente |
| Cliente → clic actual | `Cliente.datosExtra.campanaOrigen.clickId` | JSON nullable; un snapshot por cliente, sin FK a lead/mensaje/venta | Nuevo referral reemplaza la foto; no permite recuperar todos los clics |
| Seguimiento → lead/cliente | `Actividad.leadId → Lead.id`, `Actividad.clienteId → Cliente.id` | Lead opcional N:0..1 (SET NULL); cliente obligatorio N:1 (CASCADE) | Actividad sin lead solo demuestra seguimiento de la persona |

No existe una FK directa `Mensaje.leadId`, `Conversacion.leadId` ni
`Venta.conversacionId`. Para una reserva completa sí existe el recorrido
determinista **Venta → Lead → PrimerContactoWhatsapp → Conversacion/Mensaje**.
Para leads históricos sin reserva, compartir cliente no selecciona una
conversación inequívoca. Las FKs individuales no comprueban todos los cruces
entre clientes: la revisión de agregados también debe detectar incoherencias.

El cliente se crea/reutiliza **antes** de crear el lead. En este sistema
`Cliente` incluye prospectos: tener esa fila no significa ser paciente pagador.
El funnel solicitado no puede interpretarse como cuatro altas sucesivas.

### CAMP-2 — Ventas atribuibles hoy: clasificación operativa

Aplicar A/B/C por separado a cada estado de `Venta`; para ingresos, solo GANADA.
Las categorías de la consulta son excluyentes (A tiene precedencia sobre B).

| Categoría | Regla verificable | Qué se puede afirmar |
| --- | --- | --- |
| A — vínculo directo estructural | `Venta.leadId = Lead.id`, mismo `clienteId`, `Lead.anuncioId` no vacío | La agente registró esta venta para este lead y su ID de origen |
| A CTWA trazable | Además existe `PrimerContactoWhatsapp.leadId`, mismo `anuncioId`, `mensajeId` y conversación coherentes | Se conserva también el enlace al mensaje del primer contacto |
| A formulario | `Lead.metaLeadId` y `Lead.anuncioId`, con vínculo de venta | Identidad de formulario Meta + anuncio, sin suponer conversación WhatsApp |
| B — parcial | No cumple A; cliente con snapshot de referral o algún lead de origen publicitario | Hay evidencia de contacto/origen, pero no de qué oportunidad produjo la venta |
| C — sin evidencia suficiente | No cumple A ni B | No asignar a anuncio; no significa necesariamente “orgánico” |

A es una atribución explícita registrada, **no un anuncio Meta verificado ni
causalidad demostrada**: el tipo de origen no se conserva. La verificación del
ad ID con Meta debe quedar como dimensión adicional, sin eliminar la evidencia
estructural. Una venta vinculada a un lead sin anuncio no pasa a A porque otro
lead del mismo cliente sí lo tenga.

**Conteos A/B/C y porcentaje actual: no medidos**, por base no disponible.
No extrapolar con las cifras históricas de las auditorías.

Porcentaje defendible para una futura ejecución:

```text
cobertura estructural de ventas CRM =
100 × ventas GANADA de categoría A / total Venta GANADA
```

Se informa también la cobertura por importe y el subconjunto con cadena CTWA
completa. Denominador cero → N/D. No llamarlo porcentaje de todas las ventas de
la clínica: `VentaImportada` es otra fuente y no hay deduplicación entre ambas.

### CAMP-3 — Qué queda cuando llega por A, después B y compra

[`PrimerContactoService.preparar`](../src/modules/leads/primer-contacto.service.ts)
solo actualiza reservas con `mensajeId = null`. El worker copia `anuncioId` al
lead. La prueba existente **“atribución del primer mensaje confirmado; anuncio
compartido no único”** cubre A → B antes de recuperar el alta y espera A en el
lead ([prueba](../src/modules/leads/primer-contacto.integracion.spec.ts)).

| Secuencia | Primer contacto / Lead | JSON del cliente | Venta |
| --- | --- | --- | --- |
| Primer mensaje por A; luego B en el mismo hilo | Conserva A; no crea un lead nuevo por B | Pasa a B, con su clic o null | Si elige ese lead, queda ligada a A |
| Primer mensaje orgánico; después anuncio B | Sigue WHATSAPP_DIRECTO, anuncio null | Puede pasar a B | No es venta publicitaria directa por ese lead |
| Paciente existente, nuevo hilo comercial | Puede crearse un lead nuevo para ese hilo | Se reemplaza la foto global del cliente | Depende del lead elegido, no de la antigüedad del cliente |
| Hilo histórico sin reserva | No se crea reserva retrospectiva ni se rearma | Puede guardar el nuevo referral | No se recupera la cadena mensaje→lead automáticamente |
| Llega en línea no comercial | No crea lead comercial ni captura ese snapshot | No se actualiza por este camino | No atribuirla usando el snapshot de otra línea |

El primer contacto actual es **primer mensaje que confirma la activación de la
reserva**, no necesariamente el primer clic ni el primer timestamp de Meta.
`WhatsappMessageDto` no modela el timestamp del mensaje entrante; `Mensaje.createdAt`
es hora de inserción. Webhooks retrasados/concurrentes pueden alterar el orden.

**Propuesta:** conservar todos los puntos de contacto identificados y derivar
ambos extremos: primer contacto publicitario y último contacto publicitario
antes de la venta, dentro de una ventana explícita. Mantener además el primer
contacto total (puede ser orgánico), timestamp de Meta y timestamp de recepción.
La venta debe congelar qué contacto(s) y versión de regla se usaron.

First-touch y last-touch son **dos vistas alternativas**, no importes que se
suman. Ventana configurable inicialmente propuesta de 30 días con comparación
7/90, sujeta a medir el ciclo real; no cambiarla para mejorar artificialmente
el ROAS. Nunca reemplazar retrospectivamente A por B en un lead histórico.

### CAMP-4 — Ciclo exacto de ctwa_clid

Entrada: `WhatsappReferralDto.ctwa_clid` →
`extraerReferral().clickId` →
`Cliente.datosExtra.campanaOrigen.clickId`.

Condición de escritura: línea comercial y al menos
`titular || anuncioId || cuerpo`. Un referral que traiga solo clic no cumple
esa condición. Un referral posterior válido sin clic escribe **null**, perdiendo
el clic anterior. Mensajes sin referral no lo borran por esta ruta.

No está en `Mensaje`, `PrimerContactoWhatsapp`, `Lead` ni `Venta`. Tampoco se
copia al crear venta. Se podría leer indirectamente desde el cliente, pero el
clic podría pertenecer a B mientras la venta está asociada al lead de A.
**Incluso si el anuncio coincide, dos clics del mismo anuncio son distintos.**

La foto se actualiza antes de la transacción que inserta el mensaje y activa
el primer contacto. Por tanto puede existir snapshot aun si falla ese mensaje;
tampoco ofrece una garantía de “último clic cronológico” frente a concurrencia.

Conclusión: **no se garantiza que el clic sobreviva durante todo el ciclo ni que
el clic recuperado sea el de esa venta**. Hace falta guardarlo por contacto y
fijar la referencia de atribución, no fabricar uno ni reutilizar el último.

`source_id` identifica una fuente compartida por muchas personas;
`ctwa_clid` identifica el clic. No son intercambiables. La documentación actual
de Meta señala que los anuncios en Estados de WhatsApp pueden omitir el clic:
ausencia de `ctwa_clid` no demuestra origen orgánico
([referencia oficial de webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/image)).

### CAMP-5 — Qué significa source_id y qué está probado

Para CTWA con `source_type = ad`, la referencia oficial lo documenta como
**ad ID**, no campaign ID, ad set ID ni creative ID
([Meta: mensaje con referral](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/image)).
Para agrupar por campaña hay que resolver el ad en Marketing API.

El DTO local admite `source_type` como string opcional (comenta `ad | post`),
sin validarlo como enum. El controller lo recibe como `origenTipo`, pero la
persistencia **no conserva ese tipo**: transforma cualquier `source_id` en
`anuncioId`. Por tanto un origen de tipo `post` o desconocido no puede promoverse
a “anuncio confirmado” solo por el nombre de la columna. No se ha demostrado que
la clínica reciba actualmente posts: no hubo payload real disponible.

Ejemplos **de pruebas**, no campañas reales:

| Fixture | Evidencia |
| --- | --- |
| `source_type: ad`, `source_id: 120215839201920` | Controller lo transforma en `anuncioId`; no se comprobó que ese objeto exista en Meta |
| `source_type: ad`, `source_id: 999`, clic de prueba | Controller reenvía `clickId`; fixture sintético |
| `anuncio-compartido` → `anuncio-posterior` | Prueba de integración demuestra conservación del primer ID en lead |

No consultar IDs sintéticos para inferir permisos o inventario. Verificar
identidad de un source histórico exige datos reales y acceso al activo.
Además, distinguir Facebook/Instagram mediante una URL que contenga
`instagram` es una **heurística del código**; `fb.me` no prueba placement de
Facebook. Para esa dimensión hace falta evidencia Meta.

### CAMP-6 — Inventario histórico: resultados y medición pendiente

| Agregado solicitado | Resultado actual | Definición para medirlo |
| --- | --- | --- |
| Total conversaciones / leads / clientes | N/D | COUNT por entidad en un mismo snapshot |
| Conversaciones con source_id | N/D | PrimerContactoWhatsapp.anuncioId no vacío y FK a conversación |
| Leads con source_id | N/D | Lead.anuncioId no vacío |
| Clientes con source_id | N/D | JSON campanaOrigen.anuncioId no vacío |
| Con ctwa_clid | N/D | Solo hay conteo fiable del snapshot actual de Cliente.clickId |
| Con ambos | N/D | Ambos campos del snapshot del cliente; no todos los contactos históricos |
| Sin ambos | N/D | Informar “ninguno” y “falta al menos uno” por separado |
| Con cliente | N/D en cantidad | Obligatorio por FK en Lead, Conversacion y Venta |
| Con alguna venta del cliente | N/D | EXISTS Venta.clienteId; no atribución directa |
| Con Venta.leadId y source_id | N/D | Categoría A, desglosada por estado |
| Ambos y venta del cliente | N/D | Coexistencia de foto y venta, no prueba mismo clic |

**No existen cero registros: no existe una lectura de la base para contarlos.**
Tampoco puede contarse “mensajes históricos con referral” por buscar una columna:
el mensaje no conserva el objeto. Para leads/conversaciones, un clic en su
cliente solo es **clic actualmente asociado al cliente**, nunca “clic demostrado
de ese lead/conversación”. La consulta temporal explicita esa limitación.

Hallazgo histórico útil, sin sustituir la medición actual:

- La migración
  [20260818020000](../prisma/migrations/20260818020000_lead_anuncio_id/migration.sql)
  rescata IDs que antes ocupaban erróneamente `metaLeadId`, contrastándolos
  con el JSON del cliente.
- [20260818140000](../prisma/migrations/20260818140000_recuperar_leads_de_campana/migration.sql)
  documenta una medición de agosto: 34 clientes con huella de un anuncio,
  3 con lead y 31 a recuperar; 0 compras en ese momento. Es un **comentario
  fechado de una migración**, no consulta ejecutada hoy ni cifra vigente.
  El backfill crea leads con `Cliente.createdAt`; esa fecha no es prueba
  exacta de llegada de formulario/clic.
- [20260915002934](../prisma/migrations/20260915002934_primer_contacto_durable/migration.sql)
  no rellena reservas históricas: se pierde la cadena al mensaje para esa cohorte.
- La captura de clic figura en el commit `7194843` del 14/09/2026. La fecha del
  commit no determina por sí sola el primer clic efectivamente persistido.

Para obtener porcentajes de **nuestras ventas** hace falta una copia local
autorizada y fechada o una conexión de lectura disponible. No bastan fixtures,
comentarios ni levantar una base vacía.

### CAMP-7 — Vista construible sin gasto

Vista conceptual, sin datos ficticios:

| source_id (entidad por verificar) | conversaciones trazadas | leads | clientes únicos | ventas GANADA enlazadas | monto ganado registrado Bs |
| --- | ---: | ---: | ---: | ---: | ---: |
| A obtener mediante consulta | N/D | N/D | N/D | N/D | N/D |

Reglas:

1. Conversaciones: contar IDs de reservas con source, no todos los hilos del
   cliente ni cada mensaje como conversación nueva. Es un mínimo observado.
2. Leads: contar IDs con `anuncioId`; separar CTWA, formulario y legado.
3. Clientes: DISTINCT `Lead.clienteId`; separar nuevos/preexistentes. Un cliente
   puede aparecer bajo varios sources; no sumar esas filas como personas únicas.
4. Ventas: agrupar por el lead citado; sumar una vez por `Venta.id`.
   No contar leads CONVERTIDO como ventas ni unir mensajes y ventas antes de agregar.
5. Monto: aplicar CAMP-8. B/C permanecen “no atribuibles”, fuera del numerador.
6. Mostrar cobertura de reserva, clic, vínculo de venta y fuente verificada;
   `0` significa consulta ejecutada sin casos, `N/D` significa no medido.
7. No hay nombre de campaña fiable usando el titular; mostrar ID de origen.
   Gasto/ROAS ausentes, no cero.

La consulta temporal preagrega conversaciones, leads y ventas por separado.
Es una propuesta de consulta sobre el schema existente, no una vista creada.

### CAMP-8 — Importe, estado, fecha y definición conservadora

| Concepto | Código real | Consecuencia |
| --- | --- | --- |
| Importe | `Venta.monto Decimal(12,2)`, DTO `@IsPositive()` | Bs/BOB por contrato; no moneda por fila |
| Estado | GANADA / EN_PROCESO / PERDIDA | Excluir en proceso y perdida; GANADA es el default del alta |
| Fecha | Solo `Venta.createdAt` | Fecha de registro; no fecha de cierre/cobro ni fecha histórica editable |
| Cambio de estado | `cambiarEstado`, motivo al perder, AuditLog CAMBIO_ESTADO con de/a | Puede dejar de ser GANADA; recalcular totales actuales |
| Comprobante/pago | Método, referencia y archivo opcionales | No garantizan importe efectivamente pagado ni conciliación |
| Devoluciones | Sin entidad/importe/fecha específicos | No calcular ingreso neto de devoluciones |
| Vínculo | `leadId` opcional; servicio valida el cliente | Válido estructuralmente, elección comercial manual |

Definición implementable **sin llamarla caja cobrada**:

```text
monto de ventas ganadas atribuidas registradas (Bs) =
SUM(Venta.monto)
con estado actual GANADA
y lead explícito de categoría A
y cliente consistente
y monto positivo
y cronología coherente según las fechas disponibles
```

Una venta anterior al lead se separa como anomalía/legado, no se fuerza a una
campaña posterior. La consulta temporal usa `createdAt` como control
conservador; una venta EN_PROCESO creada antes y ganada después requiere revisar
su transición, no descartarla definitivamente ni datar el cierre al alta.

Se puede intentar reconstruir cierre desde `AuditLog` (`CREADA` con estado,
`CAMBIO_ESTADO` a GANADA), pero no es un campo financiero, no se validó su
cobertura y auditoría/venta no se escriben en una transacción conjunta en el
service. No prometer cierre exacto para toda la historia.

**“Ingresos cobrados atribuidos”: no demostrables con Venta sola.** Si se usa la
palabra ingresos en el dashboard, acompañarla de “importe ganado registrado,
sin conciliación de cobros/devoluciones”. Para ROAS de caja hacen falta cobros,
devoluciones, fechas e integración financiera fiable. No contar un estado
CONVERTIDO o una actividad completada como ingreso.

### CAMP-9 — VentaImportada: qué sí es recuperable

El cruce real de
[`ServiciosService`](../src/modules/servicios/servicios.service.ts) es
`Cliente.pac = VentaImportada.pac`, por igualdad exacta; `Cliente.pac` es UNIQUE
nullable. Es una clave de FileMaker, no matching por nombre/teléfono.

| Vínculo | Clasificación | Límite |
| --- | --- | --- |
| Importada → Cliente con mismo PAC no vacío | Recuperable de forma determinista | No hay FK; faltan códigos/fichas y la integridad depende de importación |
| Importada → teléfono de esa ficha | Determinista como atributo del cliente | No hace falta mostrarlo ni usarlo para matching |
| Importada → conjunto de leads/conversaciones de esa ficha | Determinista como conjunto | No elige qué lead/hilo originó el servicio |
| Importada → anuncio causal concreto | No recuperable de forma fiable con el vínculo actual | Fecha posterior o único lead conocido siguen siendo inferencia |
| Fila sin PAC coincidente | No recuperable desde estos campos | Mantener sin enlace, sin matching difuso |

`VentaImportada.precio` y `anticipoPlan` no son lo mismo;
`ingresoNeto = precio × 0,87` es base de comisión. `comisionable = false`
no significa necesariamente venta anulada o no cobrada. `fecha` es nullable.
No sumar `Venta` y `VentaImportada`: falta identidad de operación compartida
para descartar doble registro. Tampoco confundir filas de servicios con tickets
o clientes nuevos.

El origen importado está subordinado a `PeriodoComision` con CASCADE; borrar
o reemplazar una importación puede alterar el histórico. Una atribución futura
requiere identidad estable de operación/PAC y una regla explícita, no solo unir
tablas por paciente.

### CAMP-10 — Acceso Meta: comprobación directa nueva

Todas las llamadas fueron **GET**, Graph `v25.0`, con Authorization en cabecera,
sin imprimir URLs con tokens, cuerpos privados ni credenciales. Se reutilizó la
versión del backend; no se cambió ningún permiso.

| Comprobación | Resultado observado |
| --- | --- |
| Credencial local META_ACCESS_TOKEN | HTTP 401, OAuthException 190 / subcódigo 467 en permissions y adaccounts; inválida en estas consultas |
| Credencial local WHATSAPP_TOKEN | Válida; debug_token: SYSTEM_USER de app CRM Montalvo `1026204626700838`; tiene expiración |
| Scope ads_read | granted |
| Scope ads_management | granted; no utilizado para escrituras |
| Scope business_management | granted |
| Scopes whatsapp_business_management y whatsapp_business_manage_events | granted |
| Scope leads_retrieval | granted |
| GET /me/adaccounts | HTTP 200, data=[], sin página siguiente |
| GET /me/assigned_ad_accounts | HTTP 200, data=[], sin página siguiente: ninguna cuenta asignada devuelta para este usuario del sistema |
| GET /me/businesses | HTTP 200, data=[], sin página siguiente |
| GET /me?fields=business | HTTP 400, código 100; no permitió descubrir el negocio por ese campo |
| PAGE_ACCESS_TOKEN local | No configurado; el resolver de formularios utiliza esta variable, no META_ACCESS_TOKEN |
| Ad account ID / dataset accesible confirmado | Ninguno |
| Insights / gasto / campañas | No consultables aún sin un activo accesible identificado |

**Corrección al diagnóstico inicial:** no hace falta un nuevo MCP para hacer
GET de Marketing API; se comprobó que Graph es accesible desde esta máquina.
Tampoco se puede afirmar que falta `ads_read`: ya está concedido en un token.
La lista vacía de privilegios del MCP no equivale a la lista de scopes del token.

**Bloqueo concreto:** no hay cuenta publicitaria visible con esa credencial ni
ID de cuenta confirmado para probar acceso directo. Se comprobó también la
[lista específica de cuentas asignadas al usuario del sistema](https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/system-user/assigned_ad_accounts):
devuelve cero. Queda por identificar la cuenta que paga la clínica y verificar
su asignación; no se conoce todavía por qué no está visible. Las campañas podrían
estar en otra cuenta/portfolio. No significa
“la clínica no tiene campañas” ni “gasto cero”.

Próximo paso de acceso, sin cambiarlo durante esta investigación: identificar
el `act_<id>` de la cuenta que paga los anuncios y verificar su asignación de
lectura al usuario del sistema. Si un GET directo al ID conocido es rechazado,
corregir la asignación o usar una credencial autorizada para esa cuenta. Para
operación permanente, almacenar el secreto solo en servidor y atender su caducidad.

Consultas de lectura previstas una vez identificado el activo:

| GET | Datos |
| --- | --- |
| `/act_<id>?fields=id,name,currency,timezone_name,account_status` | Moneda, zona y cuenta |
| `/act_<id>/campaigns` | id, name, status, effective_status, objective, start_time, stop_time |
| `/act_<id>/adsets` | id, campaign_id, name, status, effective_status, start_time, end_time |
| `/act_<id>/ads` | id, campaign_id, adset_id, name, status, effective_status, creative |
| `/<ad_id>?fields=id,campaign_id,adset_id,creative` | Resolver source confirmado hacia campaña/creative |
| `/act_<id>/insights` | level=ad, time_range explícito, spend, impressions, reach, clicks, actions y IDs |

Paginar todas las respuestas. Guardar fecha de consulta, zona/moneda y ventana
de atribución Meta. Para “campañas que estamos pagando” separar estado ACTIVE
de gasto positivo en hoy/últimos 7/30 días: activa no garantiza entrega, y
pausada puede tener gasto reciente. El reach no es aditivo entre anuncios/días;
pedir el agregado Meta al nivel/rango apropiado. `clicks` incluye más que clics
hacia WhatsApp; especificar la acción exacta y no equipararla a mensajes CRM.

Base oficial:
[autorización Marketing API](https://developers.facebook.com/documentation/ads-commerce/marketing-api/get-started/authorization),
[Insights](https://developers.facebook.com/documentation/ads-commerce/marketing-api/insights).
El scope `ads_read` más acceso al activo permite lectura; distinguir acceso a
activos propios del de clientes externos y el nivel de acceso aprobado para
una integración de producción.

### CAMP-11 — Qué necesita cada indicador

| Indicador | Calculable con el modelo CRM, si hay datos legibles | Falta Meta | Falta persistencia/definición |
| --- | --- | --- | --- |
| Leads/clientes por source | Sí, con las limitaciones de A/legado | Verificar entidad y campaña | Distinguir cliente nuevo de oportunidad nueva |
| Conversaciones trazadas | Sí, subconjunto con primer contacto | No para contar ese subconjunto | Eventos posteriores y reservas históricas ausentes |
| Ventas/monto atribuibles | Sí, categoría A GANADA | No para ID de origen sin verificar | Fecha de cierre/cobro para medida financiera exacta |
| Ticket medio | Monto GANADA / nº ventas válidas | No | No confundir con cobro; N/D si denominador 0 |
| Conversión lead→venta | Leads únicos con al menos una GANADA explícita / leads de la cohorte | No | Fecha/cohorte y ventana; no contar varias compras como varios leads |
| CPL | No sin gasto | Spend por misma campaña/anuncio y cohorte | Definir leads nuevos frente a recontactos |
| Costo por venta (“CAC” solicitado) | No sin gasto | Spend | Denominador ventas válidas de A |
| CAC de clientes nuevos | No sin gasto | Spend | Primera adquisición pagada verificable; distinto de nº ventas |
| ROAS | No sin gasto | Spend y moneda | Numerador registrado vs cobrado; cobertura y ventana |
| ROI neto | No | Spend | Margen, costos y devoluciones; ROAS no es rentabilidad neta |
| Lead calificado / CPL calificado | No definido | Spend para costo | Estado/criterio de calificación comercial y fecha |

Conservar la fórmula solicitada `gasto/ventas`, pero rotularla **costo por venta**.
Para CAC de adquisición, dividir por clientes nuevos que compran, no por compras
repetidas. `ROAS = monto atribuido / gasto` exige misma moneda; no dividir Bs por
USD. Registrar criterio y fecha de conversión monetaria; no usar retrospectivamente
el tipo de cambio de hoy.

Las ratios se comparan sobre cohortes con tiempo de maduración comparable
(p. ej. leads adquiridos en agosto y compras observadas hasta un corte definido).
Ventas de septiembre de leads de agosto no deben mezclarse sin etiqueta con
gasto solo de septiembre. Denominador cero devuelve N/D; gasto positivo y cero
ventas es “sin ventas atribuibles observadas”, no una certeza de fracaso.

### CAMP-12 — Dashboard conceptual, sin construir UI

**Primera versión interna, sin gasto:** conversaciones trazadas, leads
atribuibles, compradores distintos, ventas GANADA y monto registrado atribuido.
Encima: periodo/cohorte, corte de datos, fuente, cobertura y porcentaje sin vínculo.
El snapshot de cliente se muestra como evidencia parcial, separado del vínculo A.

**Tabla:** Campaña (desconocida hasta resolver Meta) / Anuncio o source / Gasto /
Conversaciones / Leads / Clientes únicos / Ventas / Importe / Costo por venta /
CAC de clientes nuevos / ROAS. Antes de Insights, gasto y ratios = N/D.
Permitir ver fuentes con cero ventas, no solo las que convierten.

**Funnel visual solicitado:** WhatsApp → Lead → Cliente → Venta, con aclaración
“Cliente = identidad CRM, creada antes del lead”. Para análisis de conversión,
usar conversaciones trazadas → oportunidades → compradores → ventas; clientes
existentes y nuevos separados. Formularios Meta van por otro canal, sin inventar
una etapa WhatsApp. Un mismo cliente con varios leads puede hacer que los conteos
de objetos no formen una secuencia decreciente.

**Comparación:** first-touch y last-touch como selector de modelos, nunca
ingresos duplicados. Mostrar fuentes no verificadas, legado y no atribuible.
Creativos solo después de resolver `ad.creative`; las URLs del referral pueden
caducar y no identifican un creative de forma estable.

### CAMP-13 — Calidad de leads

Señales actuales:

- `EstadoLead`: NUEVO, CONTACTADO, CONVERTIDO, PERDIDO.
  **No existe CALIFICADO**, score ni fecha de calificación.
- `Actividad`: cliente obligatorio, lead opcional, tipo, estado,
  `fechaProgramada`, `completadaEn`. Permite medir seguimiento si está ligado
  al lead; completarla no demuestra asistencia, calificación ni compra.
- `Lead.motivoPerdida`: texto requerido al perder, borrado al cambiar de estado;
  útil internamente, no taxonomía histórica ni dato para exportar.
- `Venta.leadId` + GANADA: evidencia explícita de conversión.
- `Lead.estado=CONVERTIDO` no equivale a venta atribuida. El estado puede cambiar
  manualmente; `marcarConvertidos(clienteId, null)` convierte **todos los leads
  abiertos del cliente** al ganar una venta sin lead. Revertir la venta tampoco
  revierte automáticamente todos esos estados. El estado no sustituye el join.

El caso “100 leads/2 ventas frente a 30 leads/10 ventas” podrá demostrarse por
cohortes con la cadena A. Para comparar tasas de compradores usar leads con
alguna venta o clientes únicos, no el número bruto de filas Venta. Añadir tiempo
de maduración, cobertura de vínculo y desempeño de seguimiento por agente:
diferencias de atención pueden explicar parte del resultado publicitario.

Definición propuesta para calificación, pendiente de negocio: etapa comercial
explícita con fecha, responsable y criterios no clínicos. No inferir calidad a
partir de diagnósticos, tratamientos, textos de mensajes o categorías de paciente.

Primera respuesta: primera salida humana (`automatico=false`) tras el mensaje
de entrada, excluyendo fallidos/inciertos y aclarando que se mide inserción
local, no recepción real. La fecha del worker/lead puede llegar después por
reintentos; no usarla como si fuera hora del mensaje. Para lead→cierre real
hace falta fecha de cierre o auditoría completa.

### CAMP-14 — CAPI: viabilidad técnica y acceso comprobado

Dos productos con identificadores diferentes:

| Camino | Identificador de persona/evento de origen | Forma conceptual |
| --- | --- | --- |
| Click-to-WhatsApp / Business Messaging | `ctwa_clid` del contacto elegido + WABA | `action_source=business_messaging`, `messaging_channel=whatsapp`, evento y event_time reales; valor/moneda solo si admisibles |
| Instant Forms / Conversion Leads CRM | `Lead.metaLeadId` (= leadgen_id de Meta) | `action_source=system_generated`, `user_data.lead_id`, `custom_data.event_source=crm`, `lead_event_source`, etapa y timestamp |

Ni `Lead.id` (UUID del CRM) ni `source_id` sustituyen el leadgen_id o el clic.
Para formularios, Meta documenta etapas del funnel, incluido el lead recibido;
no asumir que enviar un `QualifiedLead` arbitrario por cualquier producto habilita
optimización. Para CTWA, la guía documenta Purchase y optimización de compras;
la aceptación/configuración de otras etapas requiere validar ese producto.
No atribuir `business_messaging` a una compra ocurrida fuera del chat si no lo fue.

**Permisos:** ya se observaron `whatsapp_business_management` y
`whatsapp_business_manage_events` en el token; también `ads_read`. Falta
comprobar WABA/dataset específico, vínculo y autorización efectiva sobre el
dataset, configuración comercial y nivel de acceso aplicable. El token tiene
fecha de vencimiento: no es una integración permanente lista.

La guía de Business Messaging para partners exige esos permisos y acceso al
producto; la guía de permisos distingue el caso de un desarrollador directo
con activos propios del de partners. No inferir aprobación de App Review ni
necesidad de cambiar permisos a partir del simple rol admin del MCP.

**Datos técnicos mínimos candidatos**, no autorización: evento/fecha, dataset,
clic+WABA o leadgen_id según producto, y controles internos de envío único.
Para Purchase, valor y moneda solo tras validar su admisibilidad. Mantener un
identificador interno de deduplicación sin datos clínicos; no asumir que la
deduplicación de Pixel cubre Business Messaging. No enviar nombre, teléfono,
email o su hash como respaldo automático si falta clic/leadgen_id.

Referencias oficiales:
[Business Messaging](https://developers.facebook.com/documentation/ads-commerce/conversions-api/business-messaging),
[permisos WhatsApp](https://developers.facebook.com/documentation/business-messaging/whatsapp/permissions),
[payload de Conversion Leads](https://developers.facebook.com/documentation/ads-commerce/conversions-api/conversion-leads-integration/payload-specification),
[implementación CRM](https://developers.facebook.com/documentation/ads-commerce/conversions-api/conversion-leads-integration/crm-integration/3-implementing-the-crm-integration).

### CAMP-15 — Privacidad y frontera de esta propuesta

**El dashboard puede calcularse dentro del CRM sin enviar conversiones a Meta.**
Lectura de gasto hacia CRM y exportación de actividad de pacientes hacia Meta
son decisiones distintas.

Un `Purchase` genérico unido a un clic en un anuncio médico puede revelar una
relación sanitaria aunque no incluya diagnóstico. Un hash o un click ID no lo
convierte en dato anónimo. Por ello la minimización propuesta no demuestra que
un evento sea admisible para esta clínica.

Excluir siempre diagnóstico, especialidad sensible, conversación, resultados,
tratamiento, producto clínico, médico, notas, archivos, PAC y URLs/títulos que
revelen esos datos. No derivar el evento de una clasificación clínica ni enviar
un identificador reconstruido por matching personal.

**No se declara CAPI aprobada para este caso.** Antes de habilitar cualquier
evento hay que comprobar la política vigente aplicable a la fuente de datos,
la categoría/restricciones de la cuenta y la licitud de la señal concreta.
La página de [Business Tools Terms](https://www.facebook.com/legal/terms/businesstools)
redirigió a login/bloqueo en esta consulta; no se afirma haber verificado su
texto actual. Si no se puede demostrar que la señal es admisible, el diseño
mantiene toda la atribución y el ROAS internamente. No se configuró dataset ni
se envió evento, siquiera de prueba.

### Evidencia reproducible y control de calidad de esta continuación

| Afirmación | Referencia local |
| --- | --- |
| Captura y pérdida de tipo/fecha | `whatsapp-webhook.dto.ts:110`, `whatsapp-webhook.controller.ts:80` |
| Snapshot reemplazable antes de transacción | `ingesta-whatsapp.service.ts:120`, `:149`, `:172` |
| Reserva solo para hilo nuevo comercial | `ingesta-whatsapp.service.ts:248` |
| First confirmed touch inmutable en lead | `primer-contacto.service.ts:59`, `:119`; prueba de integración `:243` |
| Venta valida mismo cliente/lead | `ventas.service.ts:65`, `:79` |
| Estado de venta y auditoría | `ventas.service.ts:270`; `schema.prisma:422` |
| Convertir leads sin vínculo de venta | `leads.service.ts:177` |
| Cruce PAC exacto | `servicios.service.ts:235` |
| Formularios reciben ad_id real | `lead-ads-graph.service.ts:92`, `:124` |

Las pruebas existentes se **leyeron**, no se volvió a ejecutar la integración:
no hay base local accesible. Las consultas temporales son una especificación
revisada contra el schema, no una medición validada en PostgreSQL. Cambios de
esta continuación: solo este Markdown; sin commit/push adicional y sin R3.

## Propuesta de implementación por fases (posterior a aprobación)

| Fase | Entrega | Criterio para avanzar |
| --- | --- | --- |
| 0 — medición y acceso | Ejecutar agregados en copia/lectura autorizada; identificar cuenta publicitaria; verificar GET de catálogo/Insights | Conteos reales A/B/C y cobertura PAC; moneda/rango; gasto observado. Sin CAPI |
| 1 — conservar evidencia | Contactos inmutables por mensaje con source_type/source_id/ctwa_clid, línea, hora de Meta y recepción; first/last touch por oportunidad | A→B, orgánico→B, duplicados, concurrencia, multi-línea y clic ausente no pierden relaciones |
| 2 — cierre comercial | Selección explícita de oportunidad en venta; fecha de cierre; calificación comercial con fecha; separar cobros/devoluciones | Venta/cliente/lead coherentes; no contar estados de lead como ventas; definir monto vs caja |
| 3 — gasto y jerarquía | Sincronización GET de cuentas/campañas/adsets/ads/creatives e Insights con moneda, zona, periodos y revisión de datos tardíos | Totales conciliados con Meta para mismo rango; resolver IDs sin inventar campañas; sin sumar reach |
| 4 — análisis interno | Tabla sin/con gasto, cohortes, first/last touch alternativos, cobertura y funnel; métricas de calidad | Cada importe trazable a ventas válidas; B/C visibles; no duplicar VentaImportada; ratios con denominadores claros |
| 5 — CAPI opcional | Evaluación separada de admisibilidad sanitaria, producto, dataset y eventos permitidos | Solo si la señal concreta cumple; si no, no construir el envío. No bloquea el dashboard interno |

No hace falta empezar por CAPI, por una UI compleja ni por cambiar presupuestos.
La fase 0 decide la cobertura real y el tamaño de las siguientes fases.

# CONCLUSIÓN EJECUTIVA

## 1. ¿Podemos saber hoy qué anuncio generó una conversación?

**En un subconjunto, podemos conservar su ID de origen y el mensaje inicial.**
Hace falta la reserva con source y mensaje. La entidad Meta no está verificada,
se pierde source_type y no se conservan todos los recontactos. No afirmar
cobertura total ni atribuir cada conversación desde el último JSON del cliente.

## 2. ¿Podemos unirlo con un lead?

**Sí para primer contacto durable completado**, con FK única al lead. No siempre
para hilos históricos: la migración no creó reservas retrospectivas. Los leads
de formulario tienen otro identificador, metaLeadId, y no implican WhatsApp.

## 3. ¿Podemos unirlo con una venta?

**Sí cuando Venta.leadId cita ese lead**, coincide el cliente y se conserva
anuncioId. Compartir cliente o estar CONVERTIDO no basta. Para ingreso registrado,
contar solo GANADA válida; para dinero cobrado faltan datos financieros.

## 4. ¿Qué porcentaje de nuestras ventas puede atribuirse actualmente?

**Desconocido, no 0 %.** PostgreSQL local rechazó conexión y no se dispuso de
lectura productiva. Se dejó consulta A/B/C y fórmula con denominador Venta
GANADA. Ningún porcentaje de fixtures o de agosto representa las ventas de hoy.

## 5. ¿Qué se pierde por VentaImportada?

Se pierde el vínculo explícito de la operación a una oportunidad/anuncio, y no
puede consolidarse sin evitar duplicados con Venta. **La identidad del paciente
sí es recuperable cuando coincide PAC exacto.** Eso no prueba causalidad
publicitaria ni importe cobrado. La proporción/importes afectados siguen sin medir.

## 6. ¿Qué falta para conocer gasto real?

Cuenta publicitaria identificada y acceso efectivo a ella, luego GET de
Insights. **Ya existe un token válido con ads_read**, pero las cuentas y
portfolios enumerados fueron cero; tampoco devolvió cuentas el endpoint específico
de asignaciones del usuario del sistema. No se ha probado que falten scopes; hay que
verificar asignación/ID de activo. El MCP limitado no impide usar Graph.

## 7. ¿Qué falta para calcular ROAS?

Gasto real, jerarquía source→ad→campaña, cobertura de ventas atribuibles,
moneda/cohorte/ventana común y definición del numerador. Se podría ofrecer
ROAS sobre monto ganado registrado, claramente rotulado; ROAS sobre dinero
cobrado requiere cobros/devoluciones. ROAS no demuestra beneficio neto.

## 8. ¿Qué cambios mínimos tendría que hacer el CRM?

Preservar cada contacto y su tipo/clic/fecha; fijar first/last touch; conservar
vínculo de venta a oportunidad y fecha de cierre; definir calificación comercial;
leer catálogo y gasto Meta; mostrar cobertura y no atribuible. No hace falta
enviar información clínica a Meta para medir internamente.

## 9. ¿Tiene sentido construir el módulo?

**Tiene sentido validar primero una versión interna pequeña.** Hay relaciones
útiles y una vía técnica real para leer Meta, pero faltan los datos para demostrar
cobertura y retorno de inversión. No está justificada todavía una promesa de
ROI completo ni una implementación CAPI. Recomendación: fase 0; si la cobertura
es insuficiente, corregir persistencia/cierre antes de presentar rankings de
campañas. Ninguna evidencia obtenida permite recomendar pausar o aumentar
presupuesto de una campaña concreta.

---

# Correcciones verificadas en código — 18 de septiembre de 2026

**Origen de estas correcciones.** Salen de una segunda investigación en paralelo
sobre las mismas siete áreas, pero **solo se incorpora lo que verifiqué yo mismo
abriendo el código citado**. La verificación adversarial de esa investigación
quedó **incompleta** (2 de ~42 veredictos, ambos confirmatorios) porque se cortó
la sesión: nada de lo que sigue depende de ella. No se reinvestigó desde cero y no
se repite lo que el informe ya tenía bien.

| Tema | Informe inicial | Evidencia nueva | Conclusión corregida |
| --- | --- | --- | --- |
| `ctwa_clid` fuera del servidor | Se describe como dato que «se guarda y no se muestra» | `conversaciones.service.ts:518` y `clientes.service.ts:98,:246` seleccionan `datosExtra: true` | **Sí sale al navegador.** La UI no lo pinta, pero viaja en el payload |
| Cruce PAC ↔ VentaImportada | «Recuperable de forma determinista» cuando el PAC coincide | `clientes.service.ts:305`: el alta por WhatsApp es `create({ data: { nombre, telefono } })` | **No disponible en general para pacientes captadas por Meta:** nacen sin PAC |
| Línea comercial | Se cita la condición «línea comercial» | `schema.prisma:264`: `comercial Boolean @default(false)` | Una línea nueva **pierde la atribución en silencio** hasta que alguien la marque |
| `OrigenLead` | Se enumeran tres valores | `schema.prisma:44-54`: nueve valores | Inventario incompleto; hay cuatro orígenes de comentario/mensaje que nada escribe |
| Funnel conversación → lead | Se presenta como etapa del embudo | El primer mensaje entrante de una línea comercial crea lead siempre | **~100 % por construcción:** no es un KPI de calidad |
| Índice sobre el JSON | No se menciona | No existe índice GIN ni equivalente sobre `Cliente.datosExtra` | Las consultas de fase 0 son seq scan sobre 15.000+ filas |
| Fecha de inicio de la atribución | Se fecha la captura del clic en `7194843` (14/09) | La captura del referral nace el 14/08/2026 (`d46d6d7`) | Son **tres pisos**, no dos (ver timeline abajo) |

## 1. El `clickId` sí sale al frontend

Hay que separar dos cosas que el skill `crm-conversaciones` mezcla al decir que
«se guarda y no se muestra»:

- **Transporte: sí llega al navegador.** `campanaOrigen.clickId` viaja dentro de
  `datosExtra`, y `datosExtra` se selecciona explícitamente en el detalle de la
  conversación (`conversaciones.service.ts:518`) y en la ficha y el listado de
  pacientes (`clientes.service.ts:98`, `:246`).
- **Renderizado: la interfaz no lo pinta**, deliberadamente y con una prueba que
  lo fija.

Consecuencia para la sección de privacidad: **no es una fuga clínica grave** —no
es un diagnóstico ni una conversación—, pero cualquier persona con acceso al
endpoint o con las DevTools abiertas puede observarlo. **No debe afirmarse que el
identificador de clic permanece exclusivamente del lado del servidor.**

## 2. PAC: corrección que reduce la atribución histórica de ingresos

Los pacientes creados desde WhatsApp se insertan con **nombre y teléfono, nada
más** (`clientes.service.ts:305`). El `pac` pertenece a las fichas importadas o
enriquecidas desde el maestro de FileMaker.

Por tanto la vía `Cliente.pac ↔ VentaImportada.pac` es determinista **cuando ambos
valores existen**, pero **no es una vía útil por defecto para las pacientes
captadas originalmente por campañas de Meta**, porque esas altas nacen sin PAC.
Solo se recupera cuando a esa ficha se le asigna después un PAC válido y ese PAC
coincide con una fila importada.

Súmese que el maestro de pacientes está importado **solo en torno al 29 %**. El
efecto combinado es material: **reduce de forma importante la capacidad de
atribuir ingresos históricos desde `VentaImportada`**, que es justamente donde
vive el volumen real de dinero.

## 3. `LineaWhatsapp.comercial` es `@default(false)`

El procesamiento del referral está condicionado a que la línea sea comercial. Con
el valor por defecto en `false`, **una línea nueva o mal configurada puede recibir
tráfico publicitario y perder la atribución silenciosamente**: no se escribe
`campanaOrigen`, no se crea la reserva de primer contacto y no queda log.

Hay que distinguir **capacidad del schema** (el modelo lo soporta) de **cobertura
real operacional** (depende de un flag que nace apagado).

Mejora futura, **no para ahora**: una validación de configuración al dar de alta
una línea, y observabilidad que avise de referrals descartados por este motivo.

## 4. `OrigenLead`: nueve valores, no tres

`schema.prisma:44-54`: `FACEBOOK_LEAD_AD`, `FACEBOOK_COMENTARIO`,
`FACEBOOK_MENSAJE`, `INSTAGRAM_LEAD_AD`, `INSTAGRAM_COMENTARIO`,
`INSTAGRAM_MENSAJE`, `WHATSAPP_DIRECTO`, `PRESENCIAL`, `IMPORTACION`.

Los cuatro de comentario/mensaje **no los escribe nada hoy**. Un anuncio que
termina en un DM o en WhatsApp sin referral se clasifica como `WHATSAPP_DIRECTO`;
con referral, como `FACEBOOK_LEAD_AD` o `INSTAGRAM_LEAD_AD` según el heurístico de
la URL, que son **los mismos valores que usa un formulario**.

**No mezclar los dos conceptos:** `origen` es clasificación interna del lead;
`referral.source_id` es la atribución publicitaria. Un lead con
`origen = FACEBOOK_LEAD_AD` no demuestra que viniera de un formulario.

## 5. El funnel conversación → lead no mide calidad

Hoy el primer mensaje entrante de una línea comercial crea un lead **siempre**,
haya anuncio o no. La conversión «conversación → lead» es por tanto **cercana al
100 % por construcción** y no debe presentarse como KPI de calidad ni de
conversión.

Para marketing sirven las etapas que de verdad discriminan:

```text
conversaciones atribuidas → contacto efectivo → oportunidad/cita → venta
```

usando las que existan realmente en el modelo. **No inventar `CALIFICADO`**: ese
estado no existe en `EstadoLead`.

## 6. Índice sobre `Cliente.datosExtra`: no existe, y no se crea ahora

No hay índice GIN ni ningún otro índice específico sobre `datosExtra`, así que las
consultas exploratorias sobre `campanaOrigen` recorren secuencialmente más de
15.000 filas.

**Para CAMP-0 no se crea ningún índice.** Evitar campañas de consultas repetidas
contra producción, medir con `EXPLAIN` cuando proceda, usar agregados acotados y
no convertir una investigación en una optimización de schema. Si el módulo llega a
construirse, el índice se evalúa entonces, contra las consultas reales.

## 7. Timeline real de la atribución (fechas absolutas)

| Periodo | Qué se persistía | Qué se puede atribuir |
| --- | --- | --- |
| **Antes del 14/08/2026** | Nada: `extraerReferral` no existía y el referral se descartaba entero | Prácticamente nada recuperable desde el CRM |
| **14/08/2026 → 13/09/2026** | Cinco campos en `campanaOrigen` (titular, anuncioId, cuerpo, origenUrl, imagenUrl) | Nivel **anuncio** (`source_id`). Se recibían y se tiraban `ctwa_clid`, `welcome_message.text`, `media_type` y `video_url` |
| **Desde el 14/09/2026** | Se añade `ctwa_clid` (como `clickId`), más saludo, tipo de media y vídeo | Anuncio **+ identificador de clic** |
| **Desde el 15/09/2026** | `PrimerContactoWhatsapp` ata anuncio → mensaje → lead | Cadena durable, **sin backfill** de lo anterior |

El `ctwa_clid` **no se puede reconstruir hacia atrás**: solo viaja en ese webhook.

# COBERTURA REAL DE ATRIBUCIÓN

Esta sección existe para no confundir dos cosas distintas.

**Capacidad estructural** — lo que el modelo *podría* enlazar: la cadena
`referral.source_id → PrimerContactoWhatsapp → Lead.anuncioId → Venta.leadId →
Venta.monto` está completa, con clave foránea en cada salto.

**Cobertura real** — lo que los datos históricos *efectivamente contienen*. Seis
factores la recortan, y ninguno está medido todavía porque no hubo acceso a la
base:

1. las altas por WhatsApp nacen **sin PAC**, de modo que la cohorte captada por
   Meta no cruza con `VentaImportada`;
2. `LineaWhatsapp.comercial` nace en `false`: el tráfico de una línea no marcada
   se pierde para la atribución;
3. **no hay referral persistido antes del 14/08/2026**;
4. **no hay `ctwa_clid` antes del 14/09/2026**;
5. `VentaImportada` no tiene vínculo con lead ni con anuncio, y está en dólares
   mientras `Venta.monto` está en bolivianos;
6. el maestro de FileMaker está importado **al ~29 %**.

**La regla:** ninguna cifra de cobertura puede presentarse hasta ejecutar los
agregados A/B/C contra datos reales. Hasta entonces, «capacidad estructural» no
autoriza a prometer atribución.

# Conclusión ejecutiva actualizada

| Pregunta | Respuesta conservadora |
| --- | --- |
| ¿Podemos saber qué anuncio originó una conversación? | **Sí**, para la cohorte con referral persistido y línea marcada como comercial |
| ¿Podemos enlazarlo con un lead? | **Sí**, en el flujo de WhatsApp es prácticamente automático |
| ¿Eso constituye una conversión útil? | **No.** El lead se crea solo: conversación → lead no es un KPI de calidad |
| ¿Podemos enlazarlo con una venta? | **Sí**, cuando existe `Venta.leadId` y el lead conserva `anuncioId` |
| ¿Podemos enlazarlo con `VentaImportada`? | **No de forma general** para pacientes captadas por Meta: nacen sin PAC |
| ¿Podemos calcular ingresos atribuibles parciales? | **Sí**, sobre `Venta` GANADA con lead explícito, en bolivianos |
| ¿Podemos calcular ROAS completo? | **No todavía**: falta el gasto de Marketing API y la cobertura de ventas no es completa |
| ¿Vale la pena construir el módulo? | **Se decide con la cobertura real medida**, no con la capacidad estructural. Fase 0 primero |

**Lo que NO puede afirmarse hoy:** ni un ROAS completo de todas las campañas, ni
los ingresos totales generados por Meta. Lo que sí puede analizarse ya es volumen
atribuido, leads, las ventas con vínculo explícito y su importe registrado.
