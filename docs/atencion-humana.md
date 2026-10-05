# Atención humana: solicitudes, prioridad y pausa de la automatización

Diseño de la etapa A (2026-10-05). Se construye sobre lo que ya existe; no hay
inbox nuevo, ni asignación nueva, ni otro canal de tiempo real.

## Lo que se reutiliza

| Pieza existente | Para qué sirve aquí |
|---|---|
| `InteraccionMensaje` + `guardarRespuesta` (fase 2 de interacciones) | Correlaciona cada botón, lista o Flow con la oferta guardada (mensaje, conversación, línea, paciente, opción, versión de Flow). La solicitud nace de esa correlación, nunca del título visible. |
| `TALK_TO_HUMAN`, `BOOK_APPOINTMENT` (`mensaje-interactivo.ts`) | Los identificadores de opción que ya ofrece la preparación de Montalvo. |
| `guardarMensajeAutomatico` (ingesta) | Es el único embudo de todo mensaje automático (acuse, pedido de datos, ubicación) y ya corre bajo un candado de Postgres por conversación. Ahí se «calla» la automatización. |
| `whereAlcanceInbox` / `wherePestanas` | La pestaña y sus contadores salen del mismo filtro que la lista, con el permiso por línea intacto. |
| `emitirActividad` + `refrescarFilaPorRealtime` + recarga al reconectar | Todo cambio de estado ya llega a las pestañas abiertas; al reconectar el frontend recarga lo autoritativo. |
| `notificarEntrante` / `LineasWhatsappService.audiencia` | El aviso de una solicitud nueva es el aviso del propio mensaje de la paciente: mismas personas, mismas líneas, mismos silencios. |
| Banda plegable de «Campaña de origen» en el hilo | Patrón visual del bloque de contexto. |

## Estado mínimo (columnas de `Conversacion`)

```
atencionSolicitadaEn   cuándo empezó la espera de una persona (no se reinicia)
atencionMotivo         SOLICITUD_EXPLICITA | SOLICITUD_CITA | REVISION
atencionMensajeId      el mensaje de la paciente que la originó (contexto)
atencionTomadaEn       cuándo la tomó alguien
atencionTomadaPorId    quién (no es `agenteId`)
automatizacionPausadaEn  la automatización no vuelve a escribir en este chat
```

No es una tabla nueva porque hay como mucho una solicitud viva por
conversación y el historial ya queda en los mensajes y en `AuditLog`. Tampoco se
reutiliza `agenteId`: en recepción la atención es compartida y `agenteId` es la
asignación comercial.

```
            ┌───────────── respuesta interactiva ─────────────┐
            ▼                                                 │
 NINGUNA ──► ESPERANDO ──tomar / responder──► EN_ATENCION ────┤
            ▲    │                                │           │
            │    └───────── resolver / cerrar ────┴──► NINGUNA
            └─────── liberar ─────────────────────┘
```

- **Estado** se deriva de las columnas: `ESPERANDO` (solicitada, sin tomar),
  `EN_ATENCION` (tomada), `NINGUNA`.
- **Prioridad** se deriva del motivo, en una sola función
  (`prioridadDeMotivo`): `SOLICITUD_EXPLICITA` → `ALTA`; el resto → `NORMAL`.
  `CRITICA` no la produce ninguna regla todavía: no hay un criterio definido y
  aprobado, y no se usa un clasificador.
- La pausa de la automatización es independiente: resolver no la levanta.
  Solo `POST …/automatizacion/reanudar`, explícito y auditado.

## Reglas deterministas

| Respuesta de la paciente (ya correlacionada por `guardarRespuesta`) | Motivo |
|---|---|
| `TALK_TO_HUMAN` vigente o caducada (fue una oferta nuestra) | `SOLICITUD_EXPLICITA` |
| Flow de cita validado, o `BOOK_APPOINTMENT` | `SOLICITUD_CITA` |
| Cualquier otra interacción, o una sin correlación / inválida / desconocida | `REVISION` |
| Segundo toque de la misma oferta (`DUPLICADA`) | ninguna acción nueva |

**Pedir a una persona escribiendo.** Además del botón, una paciente puede escribir
una frase inequívoca («quiero hablar con una persona», «necesito hablar con
recepción»). Cuenta solo si el mensaje **entero** es una de las frases de una lista
cerrada (`esPedidoDePersona`), con saludos y cortesías; «no quiero hablar con una
persona que me cobre más» o «hablar con recepción sobre mi cita» no cuentan. Nace la
misma solicitud `SOLICITUD_EXPLICITA`, en la misma transacción del mensaje y con la
misma pausa de la automatización. Con `WHATSAPP_INTERACCIONES` apagada no hace nada.
Es un reconocimiento de frases, no un clasificador: lo que no esté en la lista no
genera solicitud, y la lista no incluye nada médico.

Hoy no hay ninguna automatización que continúe una selección, así que toda
respuesta interactiva necesita a una persona: ninguna queda olvidada. Una
respuesta fuera de contexto no ejecuta nada; solo deja la solicitud de
revisión con la evidencia cifrada que ya guarda la fase 2.

Si ya había una solicitud viva, una nueva solo puede **subir** el motivo; la hora
de inicio no se toca. Si estaba tomada, sigue tomada.

## Transiciones (todas en NestJS)

| Ruta | Quién | Condición (UPDATE condicionado) |
|---|---|---|
| `POST /conversaciones/:id/atencion/tomar` | quien puede ver el chat | solicitada y sin tomar; idempotente si ya es suya; 409 si es de otra persona o ya no está |
| `POST …/atencion/liberar` | quien la tomó, o alcance global | tomada |
| `POST …/atencion/resolver` | quien puede ver el chat | solicitada |
| `POST …/automatizacion/reanudar` | quien puede ver el chat | pausada y sin solicitud viva |

- **Resolver deja constancia.** La conversación solo guarda la solicitud viva: al
  resolverla (o al cerrar el chat con ella viva) se borra de `Conversacion` y se
  escribe, **en la misma transacción**, una fila `ATENCION_RESUELTA` en `AuditLog` con
  `via` (`RESOLVER` o `CIERRE`), `motivo`, `solicitadaEn`, `tomadaEn`, `tomadaPorId`,
  `resueltaEn`, `esperaSegundos` (hasta que la tomaron, o hasta resolverla si nadie)
  y `atencionSegundos`. Si esa fila no se escribe, la solicitud no se resuelve. No hay
  columna `resueltaEn` en la conversación: sería un dato que la siguiente solicitud
  borra, y el registro ya vive en la bitácora. De dos resoluciones simultáneas gana
  una (la fila se bloquea antes de leerla).
- Contestar desde el chat (texto o plantilla) toma una solicitud en espera, en
  la misma transacción del mensaje.
- Cerrar la conversación la resuelve. El barrido de inactividad **no** cierra
  una conversación con solicitud viva.
- En una línea comercial, tomar reclama el chat del pool igual que contestar
  (`agenteId: null` → quien toma); nunca le quita el chat a otra agente. En
  recepción no se toca `agenteId`.
- Todas auditan en `AuditLog` y emiten `conversacion:actividad`.

## La automatización se calla

1. La ingesta registra la solicitud y la pausa **en la misma transacción** del
   mensaje, bajo el candado de automáticos de la conversación.
2. `guardarMensajeAutomatico` lee la pausa dentro de ese candado: no guarda
   nada si está pausada.
3. Justo antes de despachar a Meta se vuelve a mirar. Si alguien pausó entre
   guardar y despachar, el automático se retira sin salir.
4. El barrido de reintentos no reenvía un automático de un chat pausado.

La confirmación de una baja de promociones no pasa por esta pausa: responde a lo
que la paciente pidió y es una sola vez.

## Inbox

- Pestaña **Atención**: las conversaciones con solicitud viva. Orden: en espera
  antes que en atención; luego por motivo (prioridad); luego la espera más
  larga primero. Las demás pestañas no cambian de orden.
- Contadores `esperandoHumano` y `enAtencion` con el mismo alcance que la lista.
- La fila trae el estado de atención; la tarjeta muestra la espera desde
  `atencionSolicitadaEn`, que no se reinicia al recargar.

## Qué queda fuera

- Aviso automático a la paciente al pedir una persona: no hay texto aprobado y
  cada mensaje cuesta. Mismo criterio que `AUTORESPUESTA_TEXTO`.
- Detección de asunto médico o de emergencia: requiere criterios aprobados o un
  clasificador, y esta fase no usa ninguno.
- IA: no hay LLM. El punto de entrada futuro es `guardarMensajeAutomatico`, que
  ya respeta la pausa.

## Antes de activar la IA: requisito obligatorio

**Hoy el CRM NO detecta urgencias médicas ni mensajes sensibles, y no debe decirse
que lo hace.** Lo único que genera una solicitud de atención humana es un evento
explícito: tocar un botón o una lista, completar un Flow aprobado, o escribir
entera una de las frases cerradas de arriba. La prioridad `CRITICA` existe en el
contrato y ninguna regla la produce.

Un mensaje como «me siento muy mal», «sangro después de la cirugía» o «es una
emergencia» escrito con otras palabras **no** crea solicitud, **no** pausa la
automatización y **no** sube en el inbox: llega como cualquier mensaje. Mientras no
haya automatización autónoma eso lo ve una persona en la bandeja normal, como
siempre; el día que una IA conteste por su cuenta, dejaría de ser cierto.

Por eso, **antes de activar cualquier respuesta autónoma de IA** son obligatorios,
y no están hechos:

1. Un criterio **aprobado por la clínica** de qué es un asunto médico sensible y qué
   es una posible emergencia. No lo inventa el equipo técnico ni se deduce de
   palabras sueltas.
2. Su detección, con el método que ese criterio permita (reglas aprobadas o un
   clasificador evaluado con casos reales), y la prueba de que **ante la duda
   deriva a una persona**, nunca contesta.
3. Qué se le dice a la paciente ante una posible emergencia: orientación para
   buscar servicios de emergencia, aprobada por la clínica, sin diagnosticar ni
   prometer atención inmediata por WhatsApp.
4. Que la IA no pueda enviar nada en un chat con solicitud viva ni pausado
   (`guardarMensajeAutomatico` ya lo respeta: es el único punto de entrada).
5. La regla que produzca `CRITICA`, con un criterio definido, o que siga sin
   existir.

Hasta que existan, la IA solo puede preparar borradores para una persona.
