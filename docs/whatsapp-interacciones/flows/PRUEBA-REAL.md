# Flows de Montalvo: de local a la validación oficial de Meta

Revisión del 2026-10-05. Nada de esto se ejecutó: es el procedimiento, y cada paso
remoto necesita una autorización con nombre (WABA, Flow, finalidad).

## Estado

**2026-10-05:** los dos borradores existen en Meta, sin errores de validación (IDs en
`manifest.json` → `borradorMeta`). El Paso 1 está hecho; lo que sigue empieza en el Paso 2.
El enlace de vista previa vence el 2026-11-04 y abre sin sesión: no se guarda en el repo.
Si cambia un JSON antes de publicar, se sube al mismo borrador (`POST /{FLOW_ID}/assets`).

## Qué hay

| Archivo | Recorrido | Llega al CRM como |
|---|---|---|
| `solicitud-cita.v1.json` | 2 pantallas: para qué es la cita → cuándo y en qué horario → «Enviar solicitud» | Solicitud de cita (`SOLICITUD_CITA`, prioridad normal), con Especialidad, Cuándo y Horario legibles |
| `interes-promocion.v1.json` | 1 pantalla: cómo contactarte y en qué horario → «Enviar» | Respuesta para revisar (`REVISION`), con Contacto y Horario legibles |

Las dos son estáticas (sin endpoint), Flow JSON 7.3, todas las preguntas obligatorias y
de opción cerrada. El contrato que el CRM exige a cada respuesta sale del propio JSON:
`node scripts/validar-flows-locales.mjs --contrato`. `npm run build` falla si un JSON y
su contrato del `manifest.json` dejan de coincidir.

## Antes de crear nada en Meta

1. **La clínica confirma las especialidades** de `solicitud-cita.v1.json` (hoy:
   Ginecología, Maternidad y Reproducción asistida, tomadas de las áreas reales de la
   planilla, más «Otra especialidad» y «No sé, necesito orientación»). Cambiar la lista
   es editar `data-source` y correr `npm run check:flows`.
2. Si el JSON cambia **después de publicar** en Meta, no se edita: se crea
   `solicitud-cita.v2.json` con `flow_version` nuevo. Las respuestas tardías del v1
   siguen correlacionando con su oferta guardada.

## Entorno de prueba: sin tocar producción

La WABA de producción entrega sus webhooks al backend de producción. Una prueba
real en ella mete datos de prueba entre pacientes reales. Opciones, de la más
segura a la menos:

- **A. Solo validación y vista previa (sin mensajes).** Un borrador de Flow no se
  envía a nadie ni dispara webhooks: crearlo en una WABA, aunque sea la de
  producción, solo sirve para la validación oficial y la vista previa. Se borra
  (`DELETE`) mientras siga en borrador.
- **B. Recorrido completo (recomendado para la prueba real).** Una app de Meta
  aparte (p. ej. «CRM Montalvo DEV») con el número de prueba que Meta da gratis,
  y su webhook apuntando a un backend **local** por un túnel. Producción, sus
  números y sus webhooks no se tocan.

## Paso 1 · Crear el borrador y leer los errores oficiales

Por interfaz (no hace falta manipular tokens):

1. WhatsApp Manager → la WABA autorizada → Herramientas de la cuenta → **Flows** →
   Crear Flow.
2. Nombre: `montalvo_solicitud_cita_v1` · Categoría: *Appointment booking*
   (`montalvo_interes_promocion_v1` · *Lead generation* para el otro). Sin plantilla.
3. En el editor, reemplazar todo el JSON por el del archivo y **Guardar**. Los errores
   oficiales aparecen en el panel del editor, con línea y ruta. Deben ser cero.
4. **Vista previa** en el mismo editor: recorrer las pantallas, comprobar que el botón
   no se activa hasta responder todo, y volver atrás sin perder lo elegido.

Por API (Flows API), con un token de usuario del sistema leído del gestor de
secretos, nunca pegado en un chat ni en el repositorio:

```bash
# GRAPH_VERSION: la vigente según el changelog de Graph API.
# Crear el borrador (NO pasar publish=true): la respuesta trae id y validation_errors.
curl -X POST "https://graph.facebook.com/$GRAPH_VERSION/$WABA_ID/flows" \
  -H "Authorization: Bearer $TOKEN" \
  -F name=montalvo_solicitud_cita_v1 -F 'categories=["APPOINTMENT_BOOKING"]' \
  -F "flow_json=$(cat docs/whatsapp-interacciones/flows/solicitud-cita.v1.json)"
# Enlace de vista previa (vale 30 días, no pide sesión; no compartir fuera del equipo).
curl "https://graph.facebook.com/$GRAPH_VERSION/$FLOW_ID?fields=preview.invalidate(false),validation_errors,status" \
  -H "Authorization: Bearer $TOKEN"
```

Anotar el ID en `manifest.json` → `ambientes.<ambiente>.flowIds`. Hoy
`validarManifest` exige que estén vacíos: relajar esa regla para el ambiente
autorizado es parte de ese mismo cambio, no antes.

## Paso 2 · Revisarlo en WhatsApp

- La vista previa del Paso 1 se abre en el teléfono; es una representación web.
- Para verlo nativo hace falta **enviar un mensaje**: un Flow en borrador solo se
  envía con `"mode": "draft"`. Desde el número de la app DEV (opción B) a un teléfono
  de prueba autorizado. Es un envío real: necesita su propia autorización.

## Paso 3 · Recorrido completo con el CRM (opción B)

El CRM solo envía Flows **publicados** que estén en su catálogo (`prepararOferta`
exige `modo: 'published'` y `catalogoFlows()` está vacío a propósito). Por eso, en el
ambiente DEV y con autorización:

1. Publicar el Flow **en la WABA DEV** (`POST /$FLOW_ID/publish`). No afecta producción.
2. Backend local: base de desarrollo (nunca la de producción), una línea con el
   `phone_number_id` del número DEV, `WHATSAPP_INTERACCIONES=on`,
   `WHATSAPP_INTERACCIONES_RETENCION=on`, `WHATSAPP_INTERACCIONES_KEY` de prueba
   (32 bytes base64, no la de producción) y, **solo en local y sin commit**, la entrada
   de `catalogoFlows()` = salida de `--contrato` + `id` del Flow DEV.
3. App DEV: webhook al túnel del backend local, campo `messages` suscrito.
4. Desde el teléfono de prueba, escribirle al número DEV (abre la ventana de 24 h).
5. Enviar el Flow desde el CRM local (no hay botón en la interfaz; es el mismo POST
   que usaría la pantalla):

   ```bash
   curl -X POST "http://localhost:3001/conversaciones/$CHAT/mensajes" \
     -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
     -d '{"contenido":"","clientMessageId":"'$(uuidgen)'","interaccion":{"tipo":"flow",
          "cuerpo":"Para pedir una cita, responde dos preguntas.","cta":"Solicitar cita",
          "flowId":"'$FLOW_ID'","modo":"published","inicio":{"accion":"navigate","pantalla":"MOTIVO"}}}'
   ```

6. Completar el Flow en el teléfono y comprobar en el CRM local:
   - el mensaje dice «Solicitud de cita recibida. Pendiente: no hay ninguna cita reservada.»;
   - el chat aparece en «Atención» como *Solicitud de cita*, prioridad normal, con
     Especialidad, Cuándo y Horario con sus títulos (nunca IDs, `flow_token` ni JSON);
   - la automatización quedó pausada y no salió ningún mensaje automático;
   - volver a completar el mismo Flow queda como `DUPLICADA`: no crea una segunda solicitud.

## Qué está publicado y qué ve la paciente (7/10/2026)

El Flow de reserva (`reserva-cita.v1`, con endpoint) está PUBLICADO en tres WABAs, con
la misma llave del servidor registrada en cada número (`manifest.json` → `ambientes`):

| Ambiente | WABA | ¿Lo ven las pacientes? |
|---|---|---|
| prueba | 1699047341353103 | Sí: línea en `WHATSAPP_INTERACCIONES_LINEAS`, menú encendido |
| ventas | 1011426071679964 | Cuando la línea entre en `WHATSAPP_INTERACCIONES_LINEAS` y encienda su menú |
| recepcion | 1110803964711622 | Igual: preparada, apagada |

Publicar en Meta no muestra nada a nadie: el CRM solo envía un Flow desde el menú de una
línea con interacciones encendidas. Encender o apagar una línea es una variable del
servidor; el menú, un interruptor en Líneas WhatsApp → Menú.
