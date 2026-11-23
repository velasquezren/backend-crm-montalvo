# Procesar lotes de un webhook: un try/catch POR ELEMENTO

> Parte de la skill `crm-backend-module`: lee antes su [índice](../SKILL.md).

El webhook de WhatsApp **espera la persistencia antes de confirmar 200**.
Cada elemento va en su propio try/catch: una excepción en el mensaje 2 de 5 no
debe impedir los tres siguientes ni los `statuses`. Si hubo fallos de
persistencia, responde 503 para permitir el reenvío del lote. Un receptor
desconocido se descarta con 200 (ver la regla de fallos transitorios).
Ver `recibir()` y `procesarWebhook()` en `whatsapp-webhook.controller.ts`.

**La recuperación de adjuntos es independiente de la deduplicación.** La
ingesta conserva el retorno por `whatsappMsgId`. Mensaje y su
`TrabajoMediaEntrante` nacen en la misma transacción, incluso sin R2 configurado.
`MediaEntranteService` retoma pendientes/reclamados sin otro webhook, con
bloqueo de PG durante el intento, lote de 10, concurrencia 2, cancelación y
backoff. La clave de R2 sigue siendo determinista y el PUT es condicional.
No volver a descargar desde el camino de un webhook duplicado.

F06-R1 tiene regresiones PostgreSQL; F06-R2 (lead incompleto) sigue abierto.
Contrato, observabilidad y rollback en el
[informe F06-R1](../../../../docs/auditoria-f06-r1.md).
