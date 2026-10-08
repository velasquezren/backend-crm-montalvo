# Reserva y comprobante por WhatsApp

Preparación y despliegue solicitado el 7/10/2026. Piloto exclusivamente en la
línea de prueba; Recepción y Ventas permanecen fuera de la lista habilitada.
No se envían mensajes ni se crean reservas reales para probar el despliegue.

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
  → recepción / caja verifican → circuito existente de FileMaker
```

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
cambiar los activos Meta. Conservar `WHATSAPP_INTERACCIONES_LINEAS` exclusivamente
con el ID de la línea de prueba. No usar `todas`.

Reversión operativa: apagar interacciones o retirar la línea de la lista; la cola
deja de procesar. Si es necesario volver al commit previo, dejar la tabla aditiva
en su lugar; no borrar datos ni revertir automáticamente reservas/comprobantes
ya registrados en la agenda. La reserva web conserva su funcionamiento habitual.
