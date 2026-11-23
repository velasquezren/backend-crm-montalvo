# Un webhook `@Public()` se sostiene con la FIRMA, no con el rate-limit

> Parte de la skill `crm-backend-module`: lee antes su [índice](../SKILL.md).

`@SinLimite()` + `@Public()` + escritura en base es la combinación más peligrosa del
backend, y es exactamente lo que necesita un webhook. Lo único que separa ese endpoint de
internet es verificar la firma del proveedor. Meta firma cada POST con HMAC-SHA256 del
cuerpo en `X-Hub-Signature-256`; sin comprobarlo, cualquiera que conociera la URL —pública
por necesidad— podía dar de alta pacientes y leads sin límite e inyectar mensajes falsos en
el hilo de cualquier paciente. **`META_VERIFY_TOKEN` no cubre esto**: solo protege el GET
de alta de la suscripción, no los POST posteriores.

Ver `MetaSignatureGuard` (`common/guards/`). Está en `common/` y no en un módulo **porque Meta
firma todos sus webhooks igual**: WhatsApp Cloud API, Lead Ads, Messenger y los DM de Instagram
comparten cabecera, algoritmo y App Secret. Todo webhook de Meta que se añada cuelga de este
guard — un `@UseGuards(MetaSignatureGuard)` sobre el POST y ya. Hoy lo usan
`webhooks/whatsapp` y `webhooks/meta` (Lead Ads). Tres cosas que no son
obvias:

- Se firma el cuerpo **crudo**, no el JSON reserializado — requiere
  `NestFactory.create(AppModule, { rawBody: true })` en `main.ts` y `RawBodyRequest<Request>`.
- `timingSafeEqual` **lanza** si los buffers difieren en longitud, y `Buffer.from(hex,'hex')`
  trunca en silencio ante caracteres inválidos: compara longitudes antes, o una firma
  malformada es un 500 en vez de un 403.
- **Falla cerrado**: sin `META_APP_SECRET` se rechaza todo. Un modo "sin secreto, dejar
  pasar" deja el agujero abierto para siempre. El precio es que la variable es obligatoria
  para recibir mensajes.

Misma trampa en la verificación GET: `token === esperado` con `esperado` sin configurar
compara `undefined === undefined` y da por buena cualquier petición. Comprueba que la
variable exista *antes* de comparar.

**Esto ya no depende de que alguien se acuerde.** `npm run check:skills` recorre todos los
controladores bajo `webhooks/` y falla el build si un `@Post()` no lleva
`@UseGuards(MetaSignatureGuard)` o no responde `@HttpCode(200)`, y si `.env.example` deja de
documentar `META_APP_SECRET`. Se automatizó porque este agujero no reaparece por descuido, sino
por un webhook **nuevo** escrito meses después copiando el patrón de otro: cuando había dos
(`webhooks/whatsapp` y `webhooks/meta`), los dos estaban abiertos.
