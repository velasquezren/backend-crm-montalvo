# Seguridad ya montada

> Parte de la skill `crm-backend-module`: lee antes su [índice](../SKILL.md).

- `helmet()` + `compression()` en `main.ts`
- CORS restringido a `CORS_ORIGINS` (env), no abierto
- `ValidationPipe` con `whitelist` (descarta campos no declarados) — **sin** `forbidNonWhitelisted`:
  se probó y se quitó a propósito, porque rechaza con 400 los webhooks de Meta (traen decenas de
  campos que no modelamos) y tras varios 400 Meta desactiva la suscripción. `whitelist` solo ya
  protege contra que un cliente cuele campos inesperados; no lo reactives sin filtrar antes por ruta.

### Un 503 solo vale para fallos TRANSITORIOS

Un 5xx le pide a Meta que reintente el lote. Eso es exactamente lo que quieres
si lo que falló fue la base: el reintento entra y no se pierde el mensaje. Es lo
contrario de lo que quieres si el fallo es **permanente** — el reintento va a
fallar idéntico, para siempre, y Meta acaba desactivando la suscripción. Es la
misma familia del `forbidNonWhitelisted` de arriba, por otra puerta.

El caso real (2026-09-14): un `metadata.phone_number_id` que no está registrado
en `LineaWhatsapp` contaba como fallo de persistencia y el POST salía 503. Y las
cuatro líneas comparten **una sola app de Meta y un solo `META_APP_SECRET`**, así
que un número sin dar de alta podía dejar mudas a las cuatro — incluida la
comercial, la única con tráfico real de pacientes. La ventana no es teórica: el
procedimiento de alta suscribe la app a la WABA *antes* de registrar el Phone
Number ID en el CRM.

**La regla:** antes de contar algo como `fallos`, pregúntate si un reintento
podría arreglarlo. Si no, descártalo con 200 y deja un aviso que permita
recuperarlo a mano. `LineasWhatsappService.desdeWebhook` lo hace explícito en la
firma —devuelve `null` para «no es nuestro» y lanza para un error de base—, en
vez de dejar que quien llama lo adivine por el tipo de excepción.

Y el aviso tiene que llevar **lo que hace falta para arreglarlo**: el
`phone_number_id` (que es lo que se da de alta), el `display_phone_number` legible
—declarado en el DTO solo para eso, porque `whitelist` lo borraría— y los ids de
lo descartado. La versión anterior decía `'Webhook sin línea receptora
registrada'` y nada más: sabías que pasó, no de qué número.

  **Consecuencia que muerde:** `whitelist` descarta toda propiedad **sin decorador de
  `class-validator`**. Un DTO declarado sin decoradores no llega incompleto al service —
  llega `{}`, siempre, sin excepción y sin una línea en el log. Pasó con `SuscribirPushDto`
  (2026-08-10): el endpoint devolvía 200, guardaba cero y las notificaciones jamás
  funcionaron. En objetos anidados hacen falta además `@ValidateNested()` + `@Type(() => Clase)`,
  o el hijo se vacía igual. `check:skills` falla si encuentra un DTO sin ningún decorador.
- Rate limit 120/min general; **login 5/min** contra fuerza bruta — **por IP real**
  gracias a `trust proxy` (ver sección de rate-limit arriba); el webhook de WhatsApp
  va con `@SinLimite()`
- HTTP/2 en el vhost de Apache (`Protocols h2 http/1.1`); WebSocket proxyado en `/socket.io/`
- Contraseñas con bcrypt; el JWT nunca lleva datos sensibles
