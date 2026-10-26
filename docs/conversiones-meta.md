# Aviso de ventas a Meta (Conversions API, 23/10/2026)

El CRM puede avisar a Meta cada venta que vino de un anuncio de Click-to-WhatsApp,
para que la campaña optimice por pacientes que **pagan** y no solo por quienes
escriben. Está implementado y **apagado** (`META_CONVERSIONES`). Encenderlo es una
decisión de la clínica, no técnica.

## Antes de encender: lo que decide la clínica

- **Política de Meta para salud.** Meta clasifica a los anunciantes de salud y, según
  el nivel, bloquea `Purchase` y `Lead` como señal de optimización. Comprobar en el
  Administrador de Eventos qué restricciones tiene el dataset de la clínica. Si está
  restringido, enviar no aporta: Meta recibe el evento y no lo usa.
- **Privacidad.** Una compra unida al clic en un anuncio médico puede revelar una
  relación sanitaria aunque no lleve diagnóstico (CAMP-0 §CAMP-15). El evento va
  minimizado (abajo), pero eso no lo vuelve anónimo. La admisibilidad de esa señal la
  decide la clínica.
- **Acceso.** Dataset de la WABA (`GET /{waba_id}/dataset`) y un token con
  `whatsapp_business_manage_events` y `whatsapp_business_management`.

## Qué se envía, y qué nunca

`POST https://graph.facebook.com/v25.0/{dataset}/events` con un solo evento:

```json
{ "event_name": "Purchase", "event_time": 1760965200, "event_id": "<id de la venta>",
  "action_source": "business_messaging", "messaging_channel": "whatsapp",
  "user_data": { "whatsapp_business_account_id": "<WABA>", "ctwa_clid": "<clic>" },
  "custom_data": { "currency": "BOB", "value": 1200 } }
```

Nunca: producto, médico, módulo, nombre, teléfono, email, PAC ni su hash. Si falta el
`ctwa_clid` no hay respaldo con datos personales: la venta no se avisa.
`conversiones-meta.spec.ts` lo fija.

## Cuándo una venta se avisa

Solo si, **al momento de enviarla**: está GANADA; su lead (`Venta.leadId`) vino de un
anuncio por WhatsApp (`anuncioId`, sin `metaLeadId` de formulario); la ficha guarda
el `ctwa_clid` de ESE anuncio (`datosExtra.campanaOrigen`, que guarda solo el último
clic); clic y venta están dentro de 7 días; y la línea del primer contacto tiene WABA.
Si no se cumple, queda `DESCARTADO` con el motivo.

## Cómo funciona

`ConversionMeta` es un outbox, dueño `modules/conversiones-meta`. Ventas pide
`registrarCompra` dentro de la transacción en que la venta queda GANADA (alta o cambio
de estado). La fila espera una hora (`ESPERA_ANTES_DE_AVISAR_MS`): una venta anulada
o con el lead corregido antes de eso se revalida y no sale mal. El barrido
(`@TareaPeriodica conversiones-meta`, cada 5 min) la manda.

| Estado | Significa | Qué hacer |
| --- | --- | --- |
| `PENDIENTE` | Espera su hora o un reintento por límite de uso de Meta (hasta 5, con espera creciente) | Nada |
| `ENVIADO` | Meta la recibió; `fbtraceId` para su soporte | Nada |
| `DESCARTADO` | No correspondía avisar; `motivo` dice por qué | Nada. Si vuelve a GANADA, se reactiva |
| `FALLIDO` | Meta la rechazó (4xx); `motivo` trae su código | Revisar token, dataset o permisos |
| `INCIERTO` | Corte de red o 5xx: pudo llegar | No reenviar a ciegas: **Meta no deduplica** estos eventos. Confirmar en el Administrador de Eventos |

Se reclama marcándola `INCIERTO` antes de llamar a Meta: si el proceso cae en medio,
no se reenvía sola. Una venta ya `ENVIADO` que se anula y vuelve a GANADA no sale dos
veces (el único es `ventaId`).

## Encender

```bash
# .env del servidor
META_CONVERSIONES=on
META_CONVERSIONES_DATASET_ID=<dataset>
META_CONVERSIONES_TOKEN=<token del System User>
# Opcional, para probar: el evento aparece en «Probar eventos» y no cuenta.
META_CONVERSIONES_PRUEBA=<test_event_code>
```

Requiere `TRABAJOS_PGBOSS=on` o el temporizador de respaldo (ver
`common/trabajos/trabajos.service.ts`): con cualquiera de los dos el barrido corre.
Solo se registran las ventas posteriores al encendido. Para ver el resultado:
`SELECT estado, count(*) FROM "ConversionMeta" GROUP BY 1;`

Verificación local: `conversiones-meta.spec.ts` (decisión, carga útil y lectura de
respuestas) y `conversiones-meta.integracion.spec.ts` (PostgreSQL real: transacción,
revalidación, anulación, incierto, límite de uso, concurrencia y apagado). No se envió
ningún evento real a Meta.
