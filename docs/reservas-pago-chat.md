# Reserva y comprobante por WhatsApp

Preparación y despliegue inicial del 7/10/2026 en la línea de prueba. Desde el
8/10, René autorizó y se activaron también Recepción y Ventas, con sus menús y
Flows de reserva. Posteriormente, a las 16:44 del 8/10, René pidió desactivar
únicamente el menú de Recepción; se conservan la línea, el Flow y el seguimiento
de reservas. Ventas sigue activo. [Estado y comprobaciones](ESTADO_ACTUAL.md). No se envían
mensajes ni se crean reservas reales para probar el despliegue.

## Dónde se configura cada cosa

**Líneas WhatsApp → Menú** define las opciones y textos de bienvenida. Una opción
`CITA` abre el Flow publicado para la WABA de esa línea, o el formulario de
solicitud si no tiene el de reserva. El editor muestra cuál corresponde y enlaza
al **Directorio médico**. El menú no guarda especialidades, médicos ni horas.

El Flow y la landing consultan `modules/agenda`: los datos operativos proceden
del MySQL `clinica` del VPS de ScriptCase. Directorio permite administrar esos
mismos médicos y horarios. PostgreSQL conserva las fichas editoriales y el
seguimiento del chat, no una segunda agenda. La disponibilidad usa la ocupación
real descrita en `ESTADO_ACTUAL.md`; no depende del texto del horario semanal.

## Recorrido

```text
Menú CITA → Flow cifrado → especialidad → médico → fecha → hora y datos
  → AgendaReservasService → para_agendar PENDIENTE
  → cierre sellado → webhook existente → ReservaChat + mensaje QR, transacción PG
  → despachador existente → QR en el chat
  → imagen del paciente → descarga habitual a R2 → cola durable de comprobantes
  → UPDATE condicional para_agendar → PAGADO + aviso Telegram existente
  → constancia de reserva en imagen a la paciente (una vez)
  → recepción / caja verifican → circuito existente de FileMaker
```

### La constancia de reserva (12/10/2026)

Cuando el comprobante queda registrado en la agenda (`PAGO_REGISTRADO`), la paciente
recibe una **constancia en imagen**: día y hora en grande, paciente, médico,
especialidad, lo que pagó y la dirección de la clínica, con el estado **«Pago recibido:
en verificación»** —nunca «confirmada»: ver el párrafo siguiente—. Sin número de reserva
desde el 16/10. Desde el 28/10 es una hoja blanca de comprobante (logo, estado en una
línea, datos en filas; lo que no se sabe no ocupa fila), no la franja verde del horario.
Pie con el mismo resumen en texto; sin R2, sale el texto solo. [Muestra](imagenes-whatsapp/constancia-reserva.png).

- La manda `ConstanciaReservaService` desde el trabajador de comprobantes, solo en la
  pasada que registró el pago. **Una por reserva**: `clientMessageId` estable
  (`reserva-constancia:<n.º>`) con su índice único; un reintento no la repite.
- Lee la reserva de la agenda con la cuenta de consulta (`reservasPorIds`): lo que dice es
  lo que hay en `para_agendar`, y si ya no está `PAGADO`/`ATENDIDO`, no sale.
- No sale fuera de la ventana de 24 h de Meta ni si la agenda no responde; nunca lanza (el
  pago ya quedó registrado y el acuse ya salió). Sale aunque una persona atienda el chat,
  como el acuse. No toca `esperandoRespuesta`.
- Ni carnet ni teléfono: la imagen se guarda y se reenvía. Va a `reservas/constancias/` en R2.
- **Solo en las líneas con el asistente encendido** (Sugerir o Responder solo, aunque Gemini no
  esté conectado): se prueba en la línea de prueba antes de llegar a Ventas o Recepción.
  **`CONSTANCIA_RESERVA=todas`** la manda en todas las líneas; **`CONSTANCIA_RESERVA=off`** la
  apaga. Las dos, sin desplegar.

### Lectura del comprobante con IA (22/10/2026)

Con **Leer los comprobantes** encendido en la línea (Líneas WhatsApp → Asistente; Ventas lo
tiene), el trabajador lee la imagen con Gemini **antes** de llevarla a la agenda, con el mismo
lector y las mismas reglas que los pagos de promociones (`evaluarComprobante`); lo propio de
las citas está en `conversaciones/comprobante-reserva.ts`:

| Lo que leyó | Qué pasa |
| --- | --- |
| Comprobante con el **monto pedido**, en Bs, con **fecha** desde el envío del QR (±1 h) y **número de operación** que no llegó antes por otra cita ni promoción | Sigue el camino de siempre: `para_agendar` en PAGADO, Telegram, constancia. |
| Monto distinto, otra moneda, fecha anterior al QR o futura, operación repetida, o sin fecha u operación legibles | `REVISION`, sin tocar la agenda. `detalle` dice qué no cuadró («Dice Bs 250; se esperaba Bs 400»). |
| No es un comprobante (una foto, el carnet) | Vuelve a `ESPERANDO_COMPROBANTE` y se le pide el comprobante **una vez** (`clientMessageId` por imagen). Una segunda imagen que tampoco lo es va a `REVISION`. |
| La IA no responde | Reintenta con espera creciente; a la tercera, `REVISION`. Nunca pasa a la agenda sin leerse. |

- **La paciente nunca se queda sin respuesta.** Al llegar la imagen recibe «✅ Recibimos su
  imagen. La estamos revisando…» (neutral: todavía no se sabe si es un comprobante). Después:
  si coincide, la constancia; si no es un comprobante, que lo envíe; si el monto no cuadra,
  cuál era el de su reserva; en cualquier otra revisión, que una persona le escribirá. Nunca
  se le menciona una operación «repetida»: puede ser un error de lectura. Un aviso por imagen
  (`clientMessageId` estable), aunque una persona esté atendiendo el chat.
- El **destinatario no se compara**: `pagos_qr` no guarda el titular de la cuenta, y sin él esa
  fila siempre saldría «mirar». Caja lo ve en la imagen.
- La lectura queda en `ReservaChat.lecturaComprobante` (migración aditiva
  `20261022160000_lectura_comprobante_reserva`) con el id del mensaje leído: si la agenda falla
  después de leer, el reintento no paga otra lectura. Los pagos de promociones comparan también
  contra estas lecturas para detectar un comprobante reutilizado, y viceversa.
- La ficha del chat (Próximas reservas) muestra la lectura con cada punto, como el bloque del pago
  de una promoción. La API la entrega sin los datos crudos (ni ordenante ni banco).
- Con el interruptor apagado, o sin IA configurada, todo sigue como antes de esta fecha.
- Un PDF sigue yendo a revisión: la agenda solo guarda imágenes.

`PAGADO` en ScriptCase significa comprobante cargado, **no pago verificado**.
La reserva todavía necesita la gestión administrativa habitual. Recepción carga
la cita en FileMaker; FileMaker escribe `agenda_med` por ODBC. Este cambio no
escribe directamente en FileMaker ni cambia ese circuito.

## Vinculación y protección

- El token del Flow contiene teléfono, línea y vencimiento (24 horas), sellados.
  El endpoint exige que la línea esté habilitada, además de firma Meta y cifrado.
- El cierre con número de reserva, importe y referencia del QR está cifrado,
  autenticado y vinculado al hash del token original. Un número escrito por el
  cliente o un resumen libre no autorizan registrar comprobantes.
- La ingesta conserva las correlaciones existentes de conversación, oferta,
  versión y respuesta. Un cierre inválido pasa a revisión, sin consumir la oferta.
- El QR debe haberse enviado por Meta. Solo se asocia una imagen a una reserva
  pendiente del mismo chat, dentro de 72 horas. Si hay varias reservas o una
  promoción pendiente simultánea, se solicita revisión humana sin adivinar.
- Apagar una línea bloquea nuevos intercambios del Flow, asociación automática,
  despacho del QR y procesamiento de comprobantes. La toma de control humana
  impide el envío automático del QR; el registro de un comprobante ya recibido
  puede terminar mientras la línea siga habilitada.
- Los Flows abiertos con tokens anteriores sin línea deben abrirse de nuevo.

## Persistencia, reintentos y límites

La migración aditiva `20261008025119_reservas_chat` crea `ReservaChat` y su enum.
El módulo dueño es `conversaciones`. Una reserva de agenda tiene un seguimiento
único; cada comprobante y QR se vinculan a un único mensaje. El mensaje QR nace
en la misma transacción que el seguimiento, con `clientMessageId` estable.
El despachador reclama el envío antes de llamar a Meta: ante un resultado
incierto conserva la reconciliación existente, sin reenvío ciego.

El trabajador revisa diez comprobantes cada 30 segundos, con reclamación
persistente de 120 segundos recuperable tras reinicio. Espera hasta seis horas
por la descarga multimedia; después deriva a revisión. Acepta JPG/PNG/WebP,
máximo 5 MB comprobados sobre bytes reales, y limita la lectura a diez segundos.
Los fallos temporales tienen hasta veinte intentos y espera creciente hasta
quince minutos. PDF, imagen inválida, reserva inexistente o ya gestionada se
derivan al personal. Nunca sobrescribe un comprobante existente.

Si falta precio o QR, o prepararlo supera tres segundos, la reserva permanece
registrada y recepción coordina el cobro: no se inventa un importe ni se cancela
la reserva. El QR se sirve desde R2 mediante el almacenamiento existente.

Estados de seguimiento: `SIN_PAGO`, `ESPERANDO_COMPROBANTE`,
`COMPROBANTE_RECIBIDO`, `PAGO_REGISTRADO`, `REVISION`, `GESTIONADA`. El chat proyecta únicamente
estado y explicación controlada: no muestra claves R2, tokens ni JSON arbitrario.
`PAGO_REGISTRADO` se presenta como comprobante registrado, pendiente de Caja.

Con [seguimiento de reservas](reservas-actividades.md) activo, la agenda cierra
la espera del QR al detectar `ATENDIDO` (`GESTIONADA` en el chat). No certifica
cobro ni atención clínica. Si recepción vuelve a dejarla pendiente, pasa a
revisión humana sin reactivar el QR anterior. Esta conciliación comparte la
transacción de la actividad y descarta lecturas atrasadas.

## Privacidad y límites pendientes

La nueva tabla no copia nombre, carnet, teléfono, información clínica ni imagen:
guarda referencias, importe, estado y fechas. Las imágenes usan el almacenamiento
y acceso ya existentes. Borrar una conversación elimina su seguimiento; borrar
un mensaje elimina su referencia. No se incorpora una nueva purga automática ni
se cambia la retención existente de mensajes y R2 en esta fase.

MySQL y PostgreSQL no comparten transacción. Si MySQL registra el comprobante y
se pierde el resultado antes de actualizar PostgreSQL, el siguiente intento
detecta la reserva ya gestionada y solicita conciliación humana; no sobrescribe
ni declara el pago confirmado. ScriptCase tampoco comparte el candado del CRM
para reservar: sigue siendo un límite del sistema existente. El QR puede estar
en caché hasta diez minutos; una rotación no se refleja instantáneamente.

## Verificación y operación

Pruebas sintéticas con PostgreSQL descartable: rollback, duplicados y respuestas
simultáneas, pertenencia al chat, cierre tardío, ambigüedad entre cobros, apagado de
líneas, control humano, envío incierto, reclamaciones tras reinicio, fallo parcial,
multimedia inválida y actualización del historial. MySQL descartable comprueba
el Flow cifrado completo y que registrar dos veces un comprobante no sobrescribe
el primero. Los conteos finales y versiones quedan en `ESTADO_ACTUAL.md`.

Desplegar: respaldo de PostgreSQL, migración aditiva, generación Prisma, build y
reinicio según la receta del repositorio. No requiere publicar otro Flow ni
cambiar los activos Meta. Conservar `WHATSAPP_INTERACCIONES_LINEAS` con los IDs
explícitos de prueba, Ventas y Recepción autorizados el 8/10. No usar `todas`.

Reversión operativa: apagar interacciones o retirar la línea de la lista; la cola
deja de procesar. Si es necesario volver al commit previo, dejar la tabla aditiva
en su lugar; no borrar datos ni revertir automáticamente reservas/comprobantes
ya registrados en la agenda. La reserva web conserva su funcionamiento habitual.
