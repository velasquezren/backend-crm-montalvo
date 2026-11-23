# Estados de entrega estilo WhatsApp (ticks): usa lo que el proveedor ya manda

> Parte de la skill `crm-backend-module`: lee antes su [índice](../SKILL.md).

Antes de construir un mecanismo propio de "¿llegó el mensaje?", revisa si el
proveedor externo ya lo notifica — WhatsApp Cloud API manda un array
`statuses` (sent/delivered/read/failed) en el mismo webhook que usa para
mensajes entrantes, correlacionado por el id que la propia API devolvió al
enviar. Ver `Mensaje.estadoEnvio` + `procesarEstadoMensaje()` en
`conversaciones.service.ts` y el manejo de `cambio.value?.statuses` en
`whatsapp-webhook.controller.ts`: no hay polling ni verificación activa,
solo escuchar lo que Meta ya envía. El estado nunca retrocede (un 'delivered'
tardío no debe pisar un 'read' que ya llegó) — se compara antes de escribir.

### "No salió" y "no sé si salió" son estados distintos

La trampa de este esquema es que el resultado de la llamada al proveedor tiene
**tres** desenlaces y sólo dos nombres obvios. Sin credenciales o con un 4xx
consta que no salió; con la red caída o un corte por tiempo **no se sabe**, y el
POST pudo entregarse. Colapsar el tercero en FALLIDO no es un detalle de
precisión: FALLIDO se le muestra a la agente como "No enviado", ella lo reenvía,
y la paciente lo recibe dos veces.

Por eso `WhatsappCloudService.enviar()` devuelve un `ResultadoEnvio`
(`ENVIADO` | `NO_SALIO` | `INCIERTO`) y no un `string | null`, y `EstadoMensaje`
tiene un `INCIERTO` que la UI pinta como "Sin confirmar", nunca como un fallo.
**Solo `NO_SALIO` se reintenta** (`ReintentoSalienteService`, tandas de 5, backoff
1/5/25 min, y se rinde fuera de la ventana de 24 h). Un INCIERTO no se reenvía
jamás por cuenta propia: se resuelve cuando llega el `statuses`.

Y para que pueda resolverse hace falta un hilo que sobreviva a no recibir la
respuesta HTTP — sin ella la fila no tiene `whatsappMsgId` con el que
correlacionar. Ese hilo es `biz_opaque_callback_data`: se manda el id de nuestra
propia fila al enviar y Meta lo devuelve en el `statuses`. Si vas a integrar otro
proveedor, busca su equivalente antes de dar por buena una máquina de reintentos:
sin él, "reintentar" y "duplicar" son la misma operación.

**Toda llamada de red a un tercero lleva `AbortSignal.timeout`.** No lo llevaban,
y un socket que Meta dejaba abierto sin contestar colgaba el despacho para
siempre en un proceso de un núcleo. Es además lo que genera el caso INCIERTO, así
que las dos cosas se arreglan juntas o ninguna.
