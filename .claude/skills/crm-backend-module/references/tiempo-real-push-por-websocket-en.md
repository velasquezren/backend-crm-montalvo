# Tiempo real: push por WebSocket en vez de que el frontend haga polling

> Parte de la skill `crm-backend-module`: lee antes su [índice](../SKILL.md).

Cuando una vista necesita reflejar cambios que otro actor produce (mensajes
entrantes de un webhook, otro agente escribiendo) el patrón es un
`@WebSocketGateway` liviano que **solo avisa que algo cambió**, nunca lleva
los datos en el payload — el dato real se sigue sirviendo por REST, que es
donde vive el escopado por rol. Ver `ConversacionesGateway`
(`conversaciones.gateway.ts`): se autentica el handshake con el mismo
`JwtService` que usa `JwtAuthGuard`, y `emitirActividad(conversacionId)` se
llama tras cada `mensaje.create` (tanto en `enviarMensaje` como en
`procesarEntrante` del webhook). Requiere `app.useWebSocketAdapter(new IoAdapter(app))`
en `main.ts` — sin esto el gateway no tiene con qué servir las conexiones.

**Un mensaje entrante debe bumpear `conversacion.updatedAt`**, no solo crear
el `Mensaje`: el inbox ordena por `updatedAt desc`, así que sin este update
un chat con un mensaje nuevo del paciente no sube al tope de la lista hasta
que un agente responda. Ambos writes van en la misma `$transaction`.
