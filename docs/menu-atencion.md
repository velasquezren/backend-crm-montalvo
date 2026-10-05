# Menú de atención: cómo recibe cada línea a la paciente

Diseño del 2026-10-05. Se construye sobre la [atención humana](atencion-humana.md)
y las [interacciones de Meta](whatsapp-interacciones/FASE-2.md): no hay bandeja nueva,
ni asignador nuevo, ni otro canal de tiempo real.

## Qué es

Cuando una paciente escribe a una línea y la conversación no está en curso, recibe
un mensaje con opciones (botones si son hasta tres cortas; si no, una lista). Cada
línea tiene el suyo y se edita en **Líneas WhatsApp → Menú** (SUPER_ADMIN).

Los **tipos** de opción son código; el **contenido** es de la clínica. Ningún texto
dirigido a la paciente tiene valor por defecto.

| Tipo | Lo que pasa al tocarla | Texto de la clínica |
|---|---|---|
| Hablar con una persona | Solicitud `SOLICITUD_EXPLICITA` (prioridad **alta**), automatización callada | Confirmación, opcional |
| Es una emergencia | Solicitud `EMERGENCIA` (prioridad **crítica**: primera en «Atención»), le **suena a todos** los que ven la línea aunque la hayan silenciado | **Orientación obligatoria** |
| Solicitar una cita | Solicitud `SOLICITUD_CITA` (normal). No reserva nada | Confirmación, opcional |
| Información | Se contesta sola con el texto. No pide persona | La información, obligatoria |
| Ubicación | Se contesta sola con el mapa de la clínica | Una línea antes del mapa, opcional |
| Promociones | Manda la lista que cargó la clínica. La elegida pasa a la asesora (`REVISION` con su título) | El texto de la lista, obligatorio |

Reglas que valida el servidor (`erroresDelMenu`, la misma función al guardar y al
leer):

- Siempre hay **Hablar con una persona**: ningún menú deja a la paciente con una máquina.
- **Es una emergencia** no existe sin la orientación que aprobó la clínica.
- **Promociones** no existe sin al menos una promoción cargada. El CRM no trae ninguna.
- Máximo 10 opciones y 10 promociones; títulos de 24, descripciones de 72 (límites
  de Meta para listas). Un tipo, una vez (salvo Información).

Un menú guardado que deja de ser válido no se envía (fail-closed) y la pantalla dice
por qué.

## Cuándo se envía

En la ingesta, después de guardar el mensaje, si **todo** se cumple:

- el menú de la línea está encendido y `WHATSAPP_INTERACCIONES=on`;
- el mensaje no es la respuesta a un botón ni un pedido/emergencia escrito;
- la automatización no está pausada (nadie pidió una persona);
- en las últimas 24 h no se le ofreció un menú ni le escribió una persona del equipo.

Pasa por `guardarMensajeAutomatico` (candado de automáticos y pausa) y se despacha
como una oferta interactiva igual que la de una agente: su respuesta se
correlaciona, sobrevive a un reinicio y no se reenvía a ciegas.

**En la línea comercial, cuando el menú sale, reemplaza al acuse fuera de horario**:
dos automáticos al mismo mensaje se leen como un sistema roto. Cuando no sale (la
conversación está en curso), el acuse funciona como siempre.

## Qué significa una selección

`guardarRespuesta` correlaciona el toque con nuestra oferta (mensaje, conversación,
paciente, opción). Solo entonces `accionDeSeleccion` mira **el menú de hoy**:

- Si la opción ya no existe (la clínica cambió el menú entre el envío y el toque), la
  respuesta queda para una persona (`REVISION`). Nunca se contesta con un texto retirado.
- Lo que se contesta solo (información, ubicación, promociones) lo hace **solo si la
  oferta está vigente y nadie pidió una persona**; si no, lo ve una persona.
- El menú se marca con `OfertaInteraccion.origen = 'MENU_ATENCION'`: cada opción se puede
  elegir más de una vez («Horarios» y después «Hablar con una persona» son dos pedidos) y
  **solo** un toque a una oferta así dispara respuestas del menú (el mismo `TALK_TO_HUMAN`
  en una plantilla de campaña pide persona sin la confirmación del menú). Un webhook
  repetido no duplica (índice único del wamid); las confirmaciones y la orientación no se
  repiten antes de 30 min, la información sí se vuelve a dar si la pide.
- Una **pregunta** («¿hay emergencia?», «¿es urgente?») no es un aviso de emergencia.
- Si Meta rechaza el menú, sale el acuse fuera de horario como siempre.
- La confirmación de persona/cita y la orientación de emergencia salen **aunque la
  automatización esté pausada**: responden a lo que ella acaba de pedir.

## Emergencia: lo que hace y lo que NO

Hace: la paciente **declara** la emergencia (botón, o escribe entera una frase de
`esAvisoDeEmergencia`: «es una emergencia», «urgente», «auxilio»…). Nace o sube la
solicitud a `EMERGENCIA`, sale la orientación aprobada y suena a todo el equipo de la
línea, también a quien la silenció.

**No hace**: detectar una emergencia descrita con otras palabras («me siento muy mal»,
«sangro»). Eso llega como cualquier mensaje. Ver «Antes de activar la IA» en
[atención humana](atencion-humana.md). Si Meta rechaza la orientación, queda FALLIDA
en el chat a la vista de quien atiende (el barrido no reintenta automáticos de un chat
pausado); la solicitud crítica ya está arriba de todo.

## Activarlo

1. Escribir el menú de cada línea en Líneas WhatsApp → Menú y dejarlo **apagado**.
2. Encender `WHATSAPP_INTERACCIONES` en el servidor (con su clave y retención: ver
   ESTADO_ACTUAL). Sin eso ningún menú sale aunque esté encendido; la pantalla lo avisa.
3. Encender el menú de una línea. Apagarlo devuelve la línea a como era.

## Extensión prevista

Un tipo nuevo (por ejemplo, abrir el Flow de solicitud de cita cuando esté publicado)
es: un valor en `TIPOS_OPCION` y `REGLAS`, su caso en `accionDeSeleccion` y en
`responderSeleccion` de la ingesta, y su definición en `TIPOS` del frontend. El
almacenamiento no cambia.
