# El asistente de IA (Gemini en Vertex)

> Guía funcional y operativa. La implementación ya existe. Las mediciones y
> modelos nombrados abajo son evidencia fechada; la selección efectiva sale de
> configuración y las banderas por línea. No reconectar Google ni reactivar
> funciones solo porque una receta de instalación aparezca en este archivo.
> Estado y límites: [ESTADO_ACTUAL](ESTADO_ACTUAL.md). Para código, elegir la
> sección del caso y sus tests; no leer las recetas de alta si la tarea es un bug.


## Médicos «a solicitud»: una solicitud de cita, no una duda (15/10/2026)

Las ecografistas y otros médicos con modalidad `A_SOLICITUD` no tienen cupos en línea
ni, casi nunca, precio cargado: recepción coordina el día y la hora. Antes el modelo no
sabía qué hacer con una cita así y la derivaba con el aviso genérico, aunque el filtro
la hubiera leído bien como VENTAS/AGENDAR.

- `buscar_medico`, `listar_medicos` y `ver_medico` traen `comoSeAgenda` en esos médicos:
  la indicación, dicha en el dato. Con `AGENDAR` no se leen días que no tienen.
- El prompt: si pide un estudio sin nombrar a nadie, buscar quién lo hace; con un médico
  a solicitud, decir cómo funciona, preguntar UNA vez qué días u horario le acomodan y,
  con eso, `pasar_a_persona` con motivo `CITA`.
- `CITA` llega a «Por atender» como `SOLICITUD_CITA` («Pidió una cita»), igual que el Flow
  de solicitud, con un texto fijo (`TEXTO_SOLICITUD_CITA`) y la automatización en pausa.

**Vacaciones del médico (27/10).** Los mismos tres traen `noAtiende` (desde, hasta,
motivo público y `vuelve`) si el médico tiene una ausencia cargada; `enviar_horario`
lo añade al texto para que el modelo lo diga junto con la imagen de siempre. El prompt
le pide decirlo con las fechas en palabras y ofrecer días desde `vuelve` u otro médico.
No depende de que el modelo obedezca: `dias_con_cupo` ya no trae esos días,
`horas_libres` responde `SIN_ATENCION` con `ausencia`, y `reservar` y la agenda los
rechazan. Ver [agenda](agenda.md#vacaciones-y-ausencias).
- Recorrido real en el servidor (`asistente:caminos`, dos casos nuevos): pregunta los días
  sin inventar horas ni buscar cupos, y con la respuesta deja la solicitud.

## Velocidad: medida, no supuesta (14/10/2026)

Lo lento de Vertex no es la llamada típica sino su cola: `gemini-3.8-flash` tuvo p50
1,8 s y p99 67 s en 7 días, y en una noche mala p50 7,6 s y p90 39 s (Cloud Monitoring
del proyecto, `model_invocation_latencies`). Cuando un modelo entero se pone lento, una
copia al MISMO modelo también tarda. Por eso:

| Paso | Modelo | Si tarda… |
|---|---|---|
| Notas de voz | `ASISTENTE_MODELO_TRANSCRIPCION` (3.5 Flash) | a los 3 s, copia al clasificador (3.5 Flash-Lite, 1,7 s) |
| Filtro de entrada | `ASISTENTE_MODELO_CLASIFICADOR` (3.5 Flash-Lite) | a los 2,5 s, copia al mismo |
| Conversar, 1.ª vuelta | `ASISTENTE_MODELO` (3.8 Flash) | a los 2,5 s, copia a `ASISTENTE_MODELO_RESPALDO` (3.7 Flash) |
| Conversar, vueltas siguientes | el que ganó la 1.ª | a los 4 s, copia al mismo |
| Comprobantes | `ASISTENTE_MODELO` | a los 8 s, copia al de respaldo |

Gana la primera respuesta y la otra se cancela (`vertex/con-respaldo.ts`). La copia es
segura porque `generateContent` no cambia nada: las herramientas las ejecuta el
despachador con la respuesta ganadora. Desde la 2.ª vuelta el turno no cambia de
modelo porque la firma del razonamiento de Gemini 3 (`crudo`) solo vale para el que la
escribió; Google desaconseja saltarla (`skip_thought_signature_validator`). El modelo
que llevó el turno queda en `TurnoAsistente.modelo`.

Cómo se eligió (datos sintéticos, en el servidor): el recorrido `asistente:caminos`
con 3.7 Flash pasó lo mismo que 3.8 Flash; 3.5 Flash dio un precio equivocado y no
pidió aclaración, así que no sirve para conversar. Con 16 notas de voz generadas por
voz sintética: 3.5 Flash p50 2,9 s y ningún nombre mal; 3.5 Flash-Lite 1,7 s pero
«Villar, que» por «Via Reque»; 3.8 Flash tuvo 429 y p90 32 s.

Descartado, con datos: caché implícita (cada llamada usa ~1.900 tokens; 3.8 Flash la
aplica desde 6.144), `thinkingLevel` MINIMAL en el clasificador (ya razona 0 tokens),
Priority PayGo (la cabecera no cambió `trafficType`), el directorio de médicos en el
prompt (el modelo igual llamó a la herramienta).

La paciente ve «escribiendo…» desde que el asistente toma su mensaje, renovado cada
20 s (Meta lo quita a los 25). La pantalla de la línea muestra la mediana y el p90 del
tiempo de respuesta de los últimos 7 días (`actividad.latencia`).

## Reservar una cita y mandar el QR del médico (15/10/2026)

El 15/10 una prueba terminó así: eligió médico, día y hora, dio su nombre, carnet y
teléfono, y el asistente la pasó a una persona sin QR. No era un fallo del modelo:
`reservar` estaba en el catálogo pero nadie la habilitaba («las reservas las hace el
Flow»), así que con los datos en la mano solo le quedaba derivar.

Ahora, en las líneas de `ASISTENTE_RESERVAS_LINEAS`:

1. Con la hora elegida, el asistente pide el nombre completo y el carnet de quien viene.
   Nunca el teléfono: es el del chat.
2. `reservar` **no escribe**. Comprueba en código: que el nombre (cada palabra, con al
   menos nombre y apellido) y el CI (sus dígitos) estén en lo que ELLA escribió en el chat
   (`datosNoDichos`); que la hora esté libre en la agenda en ese momento; y que el chat no
   tenga ya una reserva esperando su pago. Si algo falla, se lo dice al modelo para que lo
   corrija con ella. Si pasa, queda la acción `RESERVA`. Una por respuesta.
3. Al terminar el turno (si nada llegó mientras pensaba), `AsistenteChatService` la
   registra con `AgendaReservasService.reservar`, igual que la web y el Flow (con su aviso
   por Telegram), con el **celular del chat**. El texto del modelo se descarta.
4. Lo que le llega lo arma el código con `registrarReservaDeChat`, el mismo del Flow:
   el número de reserva, médico, día, hora y las instrucciones de pago en trato
   de usted, con el QR del banco del médico. Su comprobante se
   asocia a esa reserva y va a la agenda como «pago por verificar»
   (`ComprobantesReservaChatService`). Si el médico no tiene precio o QR vigente, la
   reserva sale igual y recepción le dirá cómo pagar.
5. Si la hora se ocupó entre medio, le ofrece las que quedan. Si la agenda no la registra,
   una persona (`DERIVADA_ASISTENTE`).

Solo en «Responder solo» (en «Sugerir» reserva la agente), solo a pacientes con celular de
Bolivia (la agenda solo reserva esos números) y solo si la línea también está en
`WHATSAPP_INTERACCIONES_LINEAS`: el comprobante se asocia por ese camino. En las demás
líneas, con la hora elegida pasa a una persona con médico, día y hora en el resumen, sin
pedirle datos que después recepción vuelve a pedir.

El filtro de entrada también cambió: contestar lo que la clínica le pidió para la cita (el
día, la hora, su nombre o carnet) es VENTAS/AGENDAR, no OTRO. Antes un mensaje con solo
«rene velasquez / 11340617» podía leerse como «no se entiende» y derivarse.

### La cita en curso: seguirla hasta el QR, y más rápido (15/10/2026, tarde)

La primera prueba en Ventas terminó igual que la de la mañana: médico, viernes, «5 pm», y
con «sara Bueno / 6376378» la pasó a una persona. El filtro no ve el estado de la reserva;
leyó ese mensaje como «no sé» (`ACLARAR`), y con `ACLARAR` el modelo solo tiene
`pasar_a_persona`. Además cada turno tardaba 15-25 s: cada vuelta a Gemini eran 4-6 s y el
modelo volvía a buscar al médico en cada mensaje, porque del turno anterior solo ve el texto.

- **La cita en curso sale de las herramientas, no del texto.** La traza de cada turno
  (`TurnoAsistente.herramientas`) guarda, de las herramientas de la agenda, el `medicoId` y
  la `fecha` que consultó (nunca datos de ella). `reservaEnCurso` las recorre (dos horas):
  un médico la abre, otro la cambia, la reserva hecha, una derivación o un fallo la cierran.
- **Con una cita en curso, la duda no deriva** (`decidirTriajeEnReserva`): lo médico, una
  urgencia, una queja o pedir a una persona se derivan igual; «no sé» sigue con la cita, y
  la solicitud es `AGENDAR` salvo que el filtro vea con claridad un cierre, un saludo, una
  promoción, un pago o un horario (`solicitudEnReserva`).
- **El filtro y el modelo, a la vez.** Con una cita en curso el modelo empieza junto con
  el filtro, ya con `AGENDAR`. Como nada se escribe ni se envía hasta el final del turno,
  lo adelantado solo se usa si el filtro lo confirma; si deriva, se descarta; si pide otra
  cosa, se vuelve a preguntar con eso.
- **El prompt dice de qué cita se habla** («YA VIENEN AGENDANDO: el médico es el medicoId
  «49» y el día que miraron es 2026-10-23»): no vuelve a buscarlo, y con nombre y carnet
  llama a `reservar` directamente (ella ya comprueba que la hora siga libre).
- **Sin vueltas que nadie lee.** Con la reserva comprobada (o los informes), el turno
  termina: el texto del modelo se descartaba igual. Y `buscar_medico`, cuando quiere agendar
  y hay uno solo, trae sus días con cupo (`diasConCupo`): la consulta que venía después.
- **Cada turno deja una línea en el log** del servicio: resultado, segundos,
  categoría/solicitud, vueltas, modelo y herramientas. Diagnosticar ya no necesita la base.

El turno de los datos pasa de filtro (1-3 s) + buscar médico + reservar + texto (tres
vueltas, 12-18 s) a filtro y una vuelta en paralelo (4-6 s), más la agenda y el QR.

**La causa real, confirmada después en `TurnoAsistente`:** el turno de «sara Bueno /
6376378» sí llamó a `reservar`, y salió bien; en la vuelta siguiente el modelo obedeció
«no escribas nada más», contestó vacío, y el bucle tomó ese vacío como fallo (`FALLO`, «El
modelo contestó vacío»): la reserva no se registró y la derivó. Lo cubren dos cosas: tras
una reserva ya no hay vuelta, y un texto vacío con algo que mandarle ya no es un fallo.

**Gemini medido desde el servidor (15/10, mediodía).** Primera vuelta, 8 llamadas cada uno:
3.8 Flash p50 1,6 s y máx. 12 s; 3.7 Flash p50 2,1 s, máx. 12,7 s y un 429 («Resource
exhausted»); 3.5 Flash p50 1,1 s y máx. 1,6 s; 3.5 Flash-Lite p50 0,8 s. `MINIMAL` no existe
en estos modelos (400) y 3.8 no está en `us-central1` (404). En `asistente:caminos`, 3.5
Flash fue más rápido (26-27/27), pero con los precios dio el de la consulta en vez del de
la promoción 3 de 12 veces; 3.8 Flash, 12 de 12 bien en 8-27 s. **Se queda 3.8 Flash**: en
Ventas un precio equivocado cuesta más que unos segundos. Los picos son de la capacidad
compartida de Vertex (pago por uso); quitarlos de raíz es capacidad reservada
(Provisioned Throughput), que es una decisión de costo de la clínica.

## Trato de usted (15/10/2026)

René: la IA no tutea ni vosea; trata de usted. Va en los dos prompts (`TRATO_DE_USTED`, en
`prompt-sistema.ts`) y en todos los textos fijos que el CRM le manda a una paciente: la
derivación, la nota de voz no entendida, la reserva y su QR, los comprobantes, la constancia,
la ubicación, el menú, las tarjetas y el QR de promociones, los informes y la baja de
promociones. Quedan con tú, porque no son código del CRM: las plantillas de Meta (no se tocan
sin OK), el Flow de reserva ya publicado (su JSON y sus avisos van juntos; cambiarlo es
publicar otra versión), el acuse `AUTORESPUESTA_TEXTO` del `.env` y lo que la clínica escribió
en el menú y en el conocimiento de cada línea (se edita en Líneas WhatsApp).

## Contexto y atención sin presión comercial (13/10/2026)

La clasificación incluye `solicitud`: CONSULTAR, ACLARAR, SALUDAR, CERRAR, AGENDAR,
PROMOCION, PAGAR u HORARIO. La categoría médica y su prioridad se evalúan
primero; no las rebaja una intención comercial. Solo una petición clara permite
`enviar_promocion` o `enviar_horario`; el despachador vuelve a comprobarla aunque
el modelo intente una herramienta no declarada. Sin el campo, se permite
CONSULTAR, nunca cobros. ACLARAR solo conserva `pasar_a_persona`. SALUDAR y CERRAR no
declaran ninguna herramienta (14/10): un saludo o un adiós se contestan con texto; con
`pasar_a_persona` como única opción, el modelo derivaba un «hola» si el historial traía
un tema anterior ya atendido.

La redacción usa el historial y la última corrección, sin pedir otra vez lo que
ya se sabe ni ofrecer agendar al final de cada respuesta. Una petición ambigua
se aclara; si persiste la confusión se deriva. Derivar termina el bucle y anula
los envíos acumulados. Las dudas del filtro médico siguen derivándose siempre.
Las transcripciones guardadas de audios previos forman parte del contexto.

El detalle de atención añade `explicacionAsistente` y un `origen` textual o de
audio además del interactivo. Lee el turno del mensaje de origen, limitado al
mismo chat y a la solicitud viva. La explicación es un texto operativo fijo;
no publica errores técnicos ni el resumen libre de un modelo. Realtime avisa
también cuando se termina de guardar ese turno. El frontend conserva una
explicación genérica si el backend anterior aún no tiene el campo.

Verificación reproducible con conversaciones ficticias:
`npm run asistente:caminos -- contexto`. Requiere configuración del proveedor;
no usa pacientes, base de datos ni WhatsApp. Las pruebas de integración
comprueban además el bloqueo ante un modelo que insiste en enviar una tarjeta.


Instalación nueva: el asistente queda apagado sin configuración. En el
proyecto ya hay pruebas y despliegues registrados posteriores al 10/10; no
confundir los pasos de alta de abajo con tareas pendientes de producción.

Reemplaza a `asistente-vertex.md` (9/10), que describía la mitad sin modelo. Tres
cosas de ese documento resultaron **incorrectas al comprobarlas contra el SDK y la
documentación de Google**; están corregidas aquí y en el código:

| Lo que se había supuesto | Lo que es | Consecuencia si no se corregía |
|---|---|---|
| Usar `allowedFunctionNames` para quitarle `reservar` al modelo | Solo vale en modo `ANY`, que lo obliga a llamar SIEMPRE a una función | No contestaría nunca con texto. Ahora se le declaran solo las herramientas permitidas |
| Reconstruir lo que pidió el modelo desde nombre y argumentos | Gemini 3 firma su razonamiento (`thoughtSignature`) y rechaza con 400 la vuelta siguiente sin esa firma | Fallaba la primera vez que el modelo usara una herramienta. Ahora su contenido vuelve intacto (`crudo`) |
| Modelo Gemini 2.5 / SDK 3.0 | Los 2.5 dejan Vertex el **20/10/2026**; el SDK vigente es `@google/genai` 2.28.0 (Node ≥ 20) | Habría dejado de funcionar en diez días. Ahora `gemini-3.5-flash`, por variable |

## Qué hace

**En Ventas (y en cualquier línea donde se encienda), con cuatro modos:**

| Modo | Qué pasa | Para qué |
|---|---|---|
| Apagado | Nada. La línea como siempre. | — |
| **Sugerir** | Prepara una respuesta encima de la caja de texto del chat. La agente la lleva a su caja («Usar y revisar»), la corrige y la manda ella. Puede proponer además la tarjeta de una promoción o la imagen del horario de un médico, que salen con un toque. **No le escribe a nadie ni cambia nada del chat.** | Empezar. Es lo que exige «Antes de activar la IA» ([atención humana](atencion-humana.md)) mientras la clínica no apruebe su criterio. |
| **Responder solo** | Contesta lo comercial e informativo: precios, promociones, médicos, horarios, cupos, estado de su pago. Manda la tarjeta de la promoción (con «Pagar ahora») y la imagen del horario. Lo médico, las quejas, las posibles urgencias y lo dudoso los pasa a una persona en «Atención». Con el menú de la línea encendido, el menú sale solo ante un saludo o «menú»; una pregunta la contesta él (20/10, [menú](menu-atencion.md#cuándo-se-envía)). | Fuera de horario y en picos. **No se puede encender sin el criterio de la clínica** (ver abajo). |
| **Solo médicos** (14/10/2026) | A las pacientes no les contesta: para ellas la línea funciona como Apagado (menú, acuse, personas), sin turno ni llamada al modelo. Un médico con número autorizado recibe su agenda como en «Responder solo», y a él no le sale el menú. No exige criterio. | Recepción, cuando la clínica quiere personas con las pacientes pero la agenda de los médicos por WhatsApp. |

**La lectura del comprobante** (se enciende aparte, por línea): cuando la paciente
manda la foto o el PDF de su pago, el asistente lee monto, fecha, número de
operación, banco y a nombre de quién, y el CRM lo compara con lo esperado. En el
bloque del pago aparece «Coincide con lo esperado» o «Hay algo que revisar», con cada
punto: «Dice Bs 250; se esperaba Bs 280», «A nombre de Juan Quispe, no de Clínica
Montalvo SRL», «Es del 01/10: anterior a cuando se le mandó el QR», «La operación
778899 ya llegó en otro pago: puede ser un comprobante reutilizado». **Confirmar
sigue siendo de una persona**: el asistente ahorra leer con lupa, no el criterio.

**En las citas reservadas por el chat (22/10/2026) la lectura decide qué pasa solo
a la agenda** ([detalle](reservas-pago-chat.md#lectura-del-comprobante-con-ia)): solo un
comprobante que coincide en monto, fecha y número de operación llega a `para_agendar` como
PAGADO; lo demás queda en revisión, y una imagen que no es un comprobante se le vuelve a
pedir una vez. El destinatario no se compara: el QR de la agenda no dice su titular.

**Promociones con servicios (12/10/2026)**: `listar_promociones` trae cada servicio con
su precio de promoción y el de siempre; `ver_promocion` los trae con su id; y
`enviar_promocion` acepta un `servicioId` opcional (los parámetros opcionales declarados
ahora se validan y pasan; los no declarados siguen sin pasar) para mandar la tarjeta de ese
servicio, que cobra ese. El prompt de ventas le dice que cotice cada uno con su precio y que
se paga uno por pago.

**La imagen del horario**: un PNG con la marca de la clínica (cabecera verde con el
logo, una fila por día y dos columnas, **mañana y tarde**, con el turno en la de la hora
en que empieza; los días sin atención, más bajos; la especialidad y el precio de la
consulta si la agenda lo tiene, y **la foto del médico** en un retrato redondo: la de su
ficha web publicada o, si no, la de la agenda, la misma que ve en la landing; solo JPEG o
PNG, con sus iniciales debajo por si no se puede leer), dibujado desde las casillas de la
agenda, una vez por versión del horario y de la foto, y guardado en R2. Lleva el horario en texto como pie: se copia y lo
lee un lector de pantalla. Código en `src/modules/asistente/horario-imagen.ts`; muestra
en [imagenes-whatsapp/horario-medico.png](imagenes-whatsapp/horario-medico.png).

**Una sola mano para todas las imágenes** (`src/modules/asistente/marca-imagen.ts`, 12/10):
el logo (el de `favicon.svg`), los colores del CRM, la cabecera, el pie y las pastillas.
El horario, la agenda del médico y la constancia de reserva la comparten, para que la
paciente reconozca de un vistazo que la imagen es de la clínica. Sin emojis dentro de la
imagen: la Poppins no los tiene y resvg los dibujaría como cuadros (sí van en el pie).

## Agenda del médico por WhatsApp (10/10/2026)

Un médico con su número autorizado escribe a la clínica («¿qué pacientes tengo hoy?», «mis
citas de mañana», «¿cuántas tengo confirmadas y pendientes?») y el asistente le contesta SU
agenda real. **Construido y probado; apagado por partida doble** (ver «Para encenderlo»).

**Además de su agenda, información de la clínica (12/10/2026).** El médico de prueba preguntó
«qué servicios existen» y se pasó a una persona: con un médico solo había `mi_agenda`. Ahora
también tiene las herramientas `informativa` (de solo lectura y sin datos de nadie):
especialidades, médicos y su horario, cupos y, en una línea comercial, leer promociones; y el
conocimiento de la línea va en su prompt. Sigue sin nada que mande, cobre o reserve
(`enviar_promocion`, `estado_de_pago`, `enviar_horario`, `reservar`). Un texto con horas sale si
consultó algo de la clínica; sin ninguna consulta, sigue pasando a una persona. **Cantidades y
estados de citas («3 citas», «confirmadas») nunca salen del modelo**, aunque haya consultado algo
informativo: solo de `mi_agenda`, cuyo texto arma el código (12/10). A una paciente
que pregunta lo mismo, el prompt le dice que conteste con las especialidades, las promociones y
el conocimiento, en vez de derivar.

**Quién es el médico.** El número que llega del webhook lo pone Meta, no quien escribe. En
**Directorio → médico → pestaña «WhatsApp»** (solo ADMIN o más) se asocia un número a un médico
de la agenda: `AccesoMedicoAgenda` (dueño único: `AccesoMedicoAgendaService`, módulo agenda).
Decisión del propietario: **autoriza un ADMIN, sin código de verificación por WhatsApp**. El
riesgo que eso deja —una operadora que reasigna el número— se acota así: se revoca al instante,
el número se lee en cada mensaje (sin caché), y cada alta, cambio y baja queda en `AuditLog` en la
misma transacción (con el teléfono solo como «…3102»). Un médico, un número; un número, un médico.

**De dónde sale la agenda** (`agenda-medico-citas.ts`, la regla; `agenda-medico-citas.sql.ts`, las
lecturas): `agenda_med` en estado **CREADO** → «Confirmada» (BORRADO y MODIFICADO no cuentan);
`para_agendar` **PENDIENTE** → «Por confirmar» y **PAGADO** → «Pago por verificar» (todavía no
están en `agenda_med`: es la misma regla con la que `horasLibres` decide qué hora ocupa);
ATENDIDO no se lee (ya está en `agenda_med`). Si recepción ya cargó la reserva en FileMaker y no
la marcó, se junta con su cita (misma paciente, misma casilla de 30 min). La hora es la de La
Paz y «hoy» también (`fechaCivilClinica`). De cada fila solo la hora y el nombre y, de las citas de
FileMaker, la **actividad** y el **seguro** (lo que el médico ve en su pantalla «Ver agenda»; una
reserva todavía no los tiene): ni carnet, ni teléfono, ni pago. Si la cuenta de consulta aún no
tiene permiso para esas dos columnas, la agenda sale igual sin ese renglón y queda un aviso en el log.

**Qué hace el modelo y qué no.** Elige el día y si quiere la `LISTA` o el `RESUMEN`
(`mi_agenda`, atada al médico por el contexto: no tiene parámetro de médico). **Al modelo vuelven
solo cantidades**; los nombres no pasan por el proveedor. La imagen y el texto los arma el
código (`agenda-medico-imagen.ts`: mismo SVG→PNG con resvg y la Poppins que el horario; el total
en la cabecera, los tres recuadros por estado, las citas separadas en mañana y tarde con una franja
de color por estado y, debajo del nombre, la actividad en verde y el seguro en gris —[muestra](imagenes-whatsapp/agenda-medico.png)—; clave de R2 = huella del
dibujo, en `asistente/agenda-medico/`) y **el texto del modelo se descarta** cuando
ya se mandó el listado. Si el modelo afirma horas o cantidades sin haber consultado, no sale y el
chat pasa a una persona. Sin R2, el listado sale entero en texto.

**Reglas de este camino** (cada una con su prueba, comprobada rompiéndola):

- Solo en **«Responder solo»**: el borrador de «Sugerir» lo vería una agente de ventas.
- Sin filtro de entrada ni nada que mande, cobre o reserve: `mi_agenda`, lo informativo de la
  clínica y `pasar_a_persona`; a una paciente, nunca `mi_agenda`.
- Si falla el modelo o la agenda, **no sale el acuse de las pacientes**: pasa a una persona.
- **Un médico no se pausa** (13/10): pasarlo a una persona deja la solicitud en «Atención», pero su
  próxima pregunta por la agenda se contesta (`registrarSolicitudAtencion(…, { pausar: false })`), y
  una pausa que ya tuviera su chat no lo calla. La pausa protege a una paciente que pidió una persona;
  a un médico solo lo dejaba sin su agenda hasta que alguien la reanudara. Lo que sí vale para los dos:
  si una persona de la clínica le escribió hace menos de 15 min, el asistente no interrumpe.
- **Servido, sale de «Sin responder»** (13/10): lo que el asistente le sirve entero (su agenda, un dato
  de la clínica) es una respuesta —nadie le debe nada—, así que su chat deja de esperar
  (`guardarMensajeAutomatico({ resuelve })`). Derivado, sigue esperando. A una paciente, un
  automático nunca la saca de «Sin responder».
- **Rotulado «Médico»** en la bandeja y en la cabecera del chat (`medicos-en-chat.ts`), en lugar del
  sello Gold: no es una paciente ni una venta. Su chat conserva la ingesta común: ficha y conversación; el lead automático
  de primer contacto depende de que la línea sea comercial.
- Sale por `guardarMensajeAutomatico` como todo lo del asistente; la imagen es `repetible` (preguntar
  lo mismo a los diez minutos se contesta).

**Para habilitarlo en una instalación o línea nueva** (comprobar antes qué está configurado):

1. Permisos de MySQL, una vez: `scripts/agenda/permisos-agenda-medicos.sh` (da a `crm_agenda_consulta`
   el nombre de la paciente, la actividad y el seguro de `agenda_med` y `medicos.codigo`; nunca el
   PAC ni el teléfono). Sin él, la herramienta dice que no puede consultar y el médico pasa a una
   persona. Volver a correrlo es seguro: así se sumaron actividad y seguro (20/10).
2. `AGENDA_VPS_CONSULTA=on` (ya está) y `ASISTENTE_IA=on` con la línea en «Responder solo».
3. Desplegar con la migración `20261010195626_acceso_medico_agenda` (aditiva: una tabla nueva).
4. Autorizar el número de un médico en su ficha y probar desde su teléfono, en la línea de prueba.

**Límites conocidos:** un médico que se desactiva en la agenda conserva su acceso hasta que alguien lo
quite; solo se ve un día por consulta (hasta tres días por mensaje); más de 30 citas en un día se
dibujan 30 y el resto está en el texto; las imágenes llevan nombres de pacientes y quedan en R2 como
cualquier adjunto del chat.

## Notas de voz (12/10/2026)

Una nota de voz que llega a una línea **con asistente** se escucha y se contesta como si la
hubiera escrito. Decisión del propietario (12/10), sabiendo que el audio viaja a Google.
Probado con notas sintéticas en ogg/opus (el formato de WhatsApp): transcripción fiel en 2–3 s.

- **Quién:** `EscuchaAudiosService` (Conversaciones, dueño de `Mensaje`). Espera a que
  `MediaEntranteService` deje el audio en R2 (`ASISTENTE_ESPERA_AUDIO_MS`, 20 s), lo pasa al
  puerto `TranscriptorAudio` (en Vertex o con clave: `TranscriptorVertex`, el modelo configurado para
  transcripción, sin etiquetas con clave) y guarda el texto en **`Mensaje.transcripcion`**: cada
  audio va a Google UNA vez, y el turno siguiente sigue sabiendo lo que ella dijo.
- **Cuáles:** las de la ráfaga que se contesta (lo de ella desde el último mensaje de la
  clínica), hasta 3; más de 10 MB, no. La ingesta despierta al asistente con un AUDIO como
  con un texto; una foto o un documento, no.
- **Mismas reglas que el texto:** la transcripción entra como «[Nota de voz, transcrita] …»
  y pasa por el **mismo filtro de entrada** (lo médico no llega al modelo que redacta), las
  mismas herramientas y la misma pausa. Lo que diga el audio no son instrucciones: la orden
  de transcribir le dice que no obedezca nada de lo que oiga.
- **Si no se entiende** (no bajó a tiempo, inaudible, Google falló): en «Responder solo»
  sale un texto fijo, el aviso de audio no entendido, en trato de usted; en «Sugerir», la agente ve el aviso. El modelo nunca adivina.
- **El médico** también habla: «dime qué pacientes tengo mañana» por audio consulta su
  agenda. Con un médico en «Sugerir» el turno se omite ANTES de escuchar: su audio no sale.
- **En el chat**, debajo del reproductor, la agente ve lo que el asistente entendió.
- **Línea sin asistente:** el audio no sale del CRM salvo activación explícita de transcripción interna (abajo).

### Transcripción interna para las agentes (17/10/2026)

**Desplegada y activada el 17/10 a las 11:12 La Paz**, backend `e935c2f`.
Recepción conserva `SOLO_MEDICOS` y Ventas `RESPONDER`; ambas tienen transcripción
interna. Migración `20261017150000_transcripcion_audio_chat` aplicada. Respaldo
verificado: `/root/backup-crm-audio-20261017-151017` (PostgreSQL, `.env`, `dist`,
commit anterior). Pruebas de integración con PostgreSQL y de exclusión concurrente
aprobadas, tipos/build y arranque Nest aislado comprobados. En producción:
health/base OK, login 400, guard 401 y audio sintético reconocido por el proveedor
real en 2,6 s. No se enviaron mensajes de prueba ni se procesaron audios históricos.
El frontend existente ya muestra y actualiza la transcripción; no requirió despliegue.

Autorizada por el propietario para Recepción y Ventas, independiente de si el
asistente responde. `TRANSCRIPCION_AUDIO_LINEAS` permite IDs explícitos separados
por comas (vacío = apagado, sin comodines). Conserva el modo de cada línea:
Recepción puede seguir en `SOLO_MEDICOS`; transcribir a una paciente no le da
acceso al asistente médico ni envía una respuesta al WhatsApp.

- Solo nuevos AUDIO entrantes de líneas activadas; no recorre audios históricos.
- La ingesta crea `TrabajoTranscripcionAudio` junto con `Mensaje`. El worker
  `TranscripcionAudioService` recupera el trabajo tras reinicios, espera el audio
  en R2, procesa un lote acotado cada 15 s y limita a tres intentos/24 h.
- Usa `EscuchaAudiosService` y el mismo proveedor configurado. El turno y el
  worker comparten bloqueo PostgreSQL por mensaje y releen la transcripción:
  una transcripción ya guardada no vuelve a solicitarse por concurrencia.
- Persiste únicamente `Mensaje.transcripcion` y metadatos de la tarea; emite
  actualización WebSocket después del commit. El frontend existente muestra
  «Transcripción automática» debajo del reproductor, sin una burbuja saliente.
- Funciona con chat pausado o atendido por una persona. No resuelve, asigna,
  deriva ni cambia la prioridad del chat. Los límites del transcriptor siguen
  vigentes (10 MiB, 1500 caracteres); inaudible/fallo deja el audio disponible.
- Para desactivar, retirar la línea de la variable y reiniciar; no borra textos
  existentes. La cola no contiene nombres ni texto del audio. Sus intentos no
  equivalen a turnos conversacionales en las métricas del asistente.

## Probar los caminos contra Gemini real (13/10/2026)

`npm run build && npm run asistente:caminos` (o `-- medico` para filtrar) recorre unos veinte casos
con el código compilado real —filtro, bucle, herramientas, prompts, transcriptor— y una clínica
inventada: saludo, precio, especialidades, horario, pagar, «ya pagué», fuera de tema, consulta
médica, urgencia, queja, pedir una persona, manipulación, nota de voz; y del médico: mañana, hoy en
resumen, un día con fecha, cancelar, la clínica y la agenda de otro. Cada caso afirma lo que no
puede fallar (qué herramienta, si deriva, que no invente ni dé datos bancarios) e imprime la
respuesta para juzgar el tono. Correrlo al cambiar de modelo, de prompt o de proveedor.

**La clave gratuita da 20 llamadas POR DÍA por modelo** (medido el 13/10: `GenerateRequestsPerDayPerProjectPerModel-FreeTier = 20`).
Un mensaje gasta 2–3 (filtro + una o dos vueltas), así que alcanza para unos 7 mensajes al día;
después, todo turno cae en su respaldo hasta el día siguiente. El script espera entre casos, reintenta
un 429 una vez y, si sigue, se detiene avisando que se agotó la cuota diaria. **Para pacientes —y para
probar en serio— hace falta Vertex o la API de pago.**

## Por qué así: lo que hacen los que lo hacen bien

Revisado en octubre de 2026 (Intercom Fin, Zendesk AI agents, Salesforce Agentforce,
HubSpot, y los proveedores de WhatsApp para clínicas):

1. **Alcance estrecho, datos solo del sistema.** El modelo elige herramientas; todo
   dato de la respuesta sale de una herramienta o del conocimiento que escribió la
   clínica. Es lo que separa el 76% de resolución anunciado del 38% medido cuando la
   base de conocimiento es pobre.
2. **Un filtro de entrada aparte del que conversa.** Un modelo pequeño clasifica el
   mensaje (ventas, información, saludo, médico, urgencia, queja, pide persona) con el
   criterio de la clínica, y **la decisión es código**: lo médico, las quejas y las
   urgencias nunca llegan al modelo que redacta. Ante la duda del filtro, una persona.
3. **Traspaso a una persona como camino de primera clase**, no como error: crea la
   solicitud en «Atención», pausa la automatización y le dice a la paciente un texto
   fijo (no lo escribe el modelo).
4. **Empezar en modo copiloto** (sugerir) y medir antes de dejarlo solo.
5. **Decir que es un asistente.** La primera respuesta del día empieza con «🤖
   _Asistente virtual de la clínica_». Lo pone el código, no el modelo.
6. **Política de WhatsApp (desde el 15/01/2026):** Meta prohíbe en la API de
   WhatsApp Business los asistentes de IA **de propósito general** (tipo ChatGPT); los
   bots de una empresa para atención, ventas y reservas siguen permitidos. Este
   asistente solo habla de la clínica y deriva lo demás.

## Las reglas que no se deshacen

Cada una tiene su prueba.

1. **El modelo propone, el código valida los efectos.** `reservar` no escribe
   durante el bucle: deja una acción que el CRM revalida y registra al finalizar
   el turno. Véase «Reservar una cita» al principio de esta guía.
2. **El modelo nunca manda el QR ni datos bancarios.** Para cobrar una promoción manda la
   TARJETA: la paciente toca «Pagar ahora» y el CRM le manda el QR con el monto congelado y
   registra el pago (`PromocionesChatService.iniciar`). El QR del médico sale con la reserva,
   armado por el código como en el Flow. Prueba de punta a punta en
   `asistente-chat.integracion.spec.ts`.
3. **`automaticFunctionCalling` apagado** en el adaptador.
4. **El teléfono, la conversación y la línea no son parámetros**: salen del contexto.
   El asistente no puede mirar el pago de otra paciente.
5. **Todo lo que manda pasa por `guardarMensajeAutomatico`**: respeta la pausa y la
   atención humana bajo el candado, queda `automatico` y `asistente`, y la conversación
   **sigue en «Sin responder»** (un automático no es una respuesta).
6. **CRÍTICA solo la declara ella.** Una urgencia que el asistente cree leer es
   `POSIBLE_URGENCIA` (prioridad ALTA). Si la clínica escribió la orientación de
   emergencia del menú, esa es la que recibe; si no, el texto de traspaso.
7. **Si Gemini falla, la paciente recibe lo de siempre** (el acuse fuera de horario):
   encender el asistente no puede empeorar el peor caso.
8. **No contesta** si una persona escribió en los últimos 15 minutos, si el chat está
   pausado (salvo a un médico autorizado: ver «Agenda del médico»), si lo último que
   mandó no es un texto ni una nota de voz, ni más de 15 veces por hora en un chat.

## Arquitectura

```
webhook → IngestaWhatsappService.procesarEntrante (sin cambios en su transacción)
            └─ en segundo plano: ¿la línea tiene asistente? → AsistenteChatService.programar
                                                                   │ espera 3 s (ráfagas), máx. 20 s
                                                                   ▼
                                     AsistenteChatService.atender  (modules/conversaciones)
                                        1. historial de 24 h (30 mensajes)
                                        2. ClasificadorMensajes → decidirTriaje   ← código
                                        3. ConversacionAsistente.responder        ← el bucle
                                              ModeloConversacional ⇄ HerramientasAsistenteService
                                        4. SUGERIR → SugerenciaAsistente
                                           RESPONDER → IngestaWhatsappService.responderComoAsistente
                                                       / tarjetaDesdeAsistente / imagenDesdeAsistente
                                                       / derivarDesdeAsistente
                                        5. TurnoAsistente (qué hizo, herramientas, tokens, latencia)

MediaEntranteService (descarga a R2) ─▶ LecturaComprobantesService (barrido 30 s)
                                          LectorComprobantes → evaluarComprobante ← código
                                          → PromocionesChatService.guardarLectura
```

- `modules/asistente` no conoce los chats: proveedor (puertos `ModeloConversacional`,
  `ClasificadorMensajes`, `LectorComprobantes` cableados a Vertex en `asistente.module.ts`),
  catálogo, bucle, filtro, prompt, imagen del horario y configuración por línea
  (`AsistenteLinea`, solo SUPER_ADMIN).
- La ingesta **no inyecta** al asistente: el asistente se registra al arrancar
  (`usarAsistente`), porque es el asistente el que manda por la ingesta. Sin él, la
  ingesta funciona igual que antes.
- Nada de un turno es durable a propósito: si el proceso se reinicia en medio, el
  mensaje queda en «Sin responder» para una persona. La lectura de comprobantes sí es
  un barrido durable (3 intentos por comprobante).

## «MCP de Vertex»: qué hace falta de verdad

El CRM **no usa MCP para hablar con Gemini**: llama a Vertex con el SDK oficial
(`@google/genai`) y una cuenta de servicio, que es lo que Google recomienda para un
servidor. MCP sirve para otra cosa: darle a un asistente de programación (Claude)
acceso a Google Cloud para que **haga la configuración** de abajo. Con eso, o con
`gcloud` autenticado en esta máquina, Claude ejecuta «Conexión, receta para Claude» de
punta a punta; sin eso, la hace René en la consola siguiendo los mismos pasos.

## Conexión, receta para Claude (cuando haya acceso a Google Cloud)

Con `gcloud` (o el MCP equivalente) y el id del proyecto. Ningún paso imprime la llave.

```bash
PROYECTO=<id-del-proyecto>
CUENTA=crm-asistente@$PROYECTO.iam.gserviceaccount.com
gcloud config set project "$PROYECTO"
gcloud services enable aiplatform.googleapis.com
gcloud iam service-accounts create crm-asistente --display-name="CRM Montalvo · asistente"
gcloud projects add-iam-policy-binding "$PROYECTO" --member="serviceAccount:$CUENTA" --role="roles/aiplatform.user" --condition=None
# Si la organización prohíbe llaves (iam.disableServiceAccountKeyCreation), lo dice aquí: avisar a René.
gcloud iam service-accounts keys create /tmp/google-asistente.json --iam-account="$CUENTA"
scp /tmp/google-asistente.json root@107.175.132.15:/opt/crm-backend/secretos/google-asistente.json && rm -f /tmp/google-asistente.json
```

En el servidor (`/opt/crm-backend`), una vez:

```bash
mkdir -p secretos && chown crmapp:crmapp secretos && chmod 700 secretos
chown crmapp:crmapp secretos/google-asistente.json && chmod 600 secretos/google-asistente.json
# .env: ASISTENTE_IA=on, GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION=global,
#       GOOGLE_APPLICATION_CREDENTIALS=/opt/crm-backend/secretos/google-asistente.json
sudo -u crmapp npm run asistente:probar      # cinco ✓ antes de seguir
systemctl restart crm_backend.service
```

`npm run asistente:probar` usa el adaptador COMPILADO (el mismo que corre en
producción) con datos sintéticos: el filtro, una vuelta con herramienta —la que falla
con 400 si la firma del razonamiento no vuelve intacta— y la lectura de un comprobante
dibujado en el momento. Cada fallo sale explicado: permiso, API sin activar, modelo no
disponible en la ubicación, cuota, facturación, credenciales. Lo mismo hace el botón
**«Probar conexión»** del cajón del asistente en el CRM (`POST /asistente/probar`,
SUPER_ADMIN, cinco por minuto).

## Conectarlo: paso a paso

### 1. En Google Cloud (una vez)

1. Un proyecto (o el que ya tenga la clínica) con **facturación activa**.
2. Activar la API **Vertex AI** (`aiplatform.googleapis.com`).
3. Crear una **cuenta de servicio** (p. ej. `crm-asistente`) con el rol
   **Vertex AI User** (`roles/aiplatform.user`) y nada más.
4. Crear una **llave JSON** de esa cuenta y descargarla.
5. Recomendado: en Vertex AI, desactivar el *caching* de datos del proyecto (retención
   cero). Google no usa los datos de Vertex para entrenar, pero por defecto cachea
   entradas 24 h.

### 2. En el servidor (`/opt/crm-backend`)

```bash
# La llave, fuera del repo y legible solo por el servicio
install -m 600 -o crm -g crm crm-asistente.json /opt/crm-backend/secretos/google-asistente.json
```

En `.env`:

```bash
ASISTENTE_IA=on
GOOGLE_CLOUD_PROJECT=<id-del-proyecto>
GOOGLE_CLOUD_LOCATION=global
GOOGLE_APPLICATION_CREDENTIALS=/opt/crm-backend/secretos/google-asistente.json
# Opcionales (estos son los valores por defecto):
# ASISTENTE_MODELO=gemini-3.5-flash
# ASISTENTE_MODELO_CLASIFICADOR=gemini-3.5-flash-lite
# ASISTENTE_MODELO_RESPALDO=gemini-3.7-flash      (off = copia al mismo modelo)
# ASISTENTE_MODELO_TRANSCRIPCION=gemini-3.5-flash
# ASISTENTE_ESPERA_MS=3000
```

En producción (14/10/2026): `ASISTENTE_MODELO=gemini-3.8-flash`, respaldo
`gemini-3.7-flash`, transcripción `gemini-3.5-flash`.

Comprobar con `sudo -u crmapp npm run asistente:probar` (cinco ✓: configuración, filtro,
conversación con herramienta, comprobante y nota de voz) y reiniciar
`crm_backend`. En el CRM, **Líneas WhatsApp → Asistente** dice «Conectado a Gemini
(gemini-3.5-flash)» y su botón **«Probar conexión»** repite la prueba.

**El modelo va con su nombre exacto, nunca `-latest`.** `gemini-3.5-flash` es estable
y Google no lo retira antes de mayo de 2027. Los 3.6, 3.7 y 3.8 Flash existen pero son
de «disponibilidad corta» (pueden retirarse 45 días después de salir el siguiente).
Cambiar de modelo es cambiar la variable y reiniciar.

### 3. En el CRM (René, como SUPER_ADMIN)

1. **Líneas WhatsApp → Asistente** en la línea de prueba (+1 555-194-8320).
2. Escribir **«Lo que la clínica quiere que sepa»**: qué incluye cada consulta, políticas
   (reembolsos, cómo se agenda, qué se lleva), preguntas frecuentes. Precios, médicos,
   horarios y promociones NO: esos los lee del CRM.
3. Escribir **«Lo que SIEMPRE pasa a una persona»**: el criterio clínico. Es el requisito
   para «Responder solo».
4. Modo **Sugerir** y encender **Leer los comprobantes**. Probar desde el teléfono.
5. Pasar a Ventas en **Sugerir** una o dos semanas. En el mismo cajón se ve qué hizo
   (respondió, sugirió, derivó, falló). Si las sugerencias se usan casi sin cambios,
   pasar a **Responder solo**.

## Costo

Con los precios publicados de `gemini-3.5-flash` en Vertex (USD 1,50 por millón de
tokens de entrada y 9 de salida, octubre 2026, fuentes de terceros): un turno típico
(filtro + dos vueltas con herramientas) ronda los 8.000 tokens de entrada y 600 de
salida → **≈ 2 centavos de dólar por respuesta**. Con unas 1.500 respuestas al mes,
**25–30 USD**. Cada turno guarda sus tokens en `TurnoAsistente`: el número real sale de
ahí, no de esta estimación. Cada llamada lleva las etiquetas `aplicacion=crm-montalvo`
y `uso=conversar|clasificar|leer-comprobante|transcribir-audio` (solo en Vertex: la API con clave no admite etiquetas), que aparecen en la factura de Google.

## Lo que queda pendiente

- **Es de la clínica, no del código:** el conocimiento y el criterio de derivación
  (arriba), la orientación de emergencia del menú, y las fichas web de los médicos.
- **Pruebas con proveedor:** existen `asistente:probar`, `asistente:caminos` y
  mediciones reales fechadas arriba. Repetir las pertinentes al cambiar modelo
  o prompts, con datos sintéticos y autorización de llamadas externas; no
  afirmar que toda la implementación solo se probó con modelos guionados.
- **Reservar por el asistente:** hecho el 15/10 (arriba). Encendido en la línea de prueba
  y en Ventas (`ASISTENTE_RESERVAS_LINEAS`); Recepción sigue en «Solo médicos».
- **Comprobantes de reservas** (QR del médico): leídos desde el 22/10 con el mismo
  interruptor por línea ([reservas-pago-chat](reservas-pago-chat.md#lectura-del-comprobante-con-ia)).
- **Notas de voz:** implementadas; `scripts/probar-asistente.mjs` pasa
  transcriptor y audio de prueba a `probarProveedor`, que incluye el paso AUDIO.
  La disponibilidad del proveedor se comprueba al ejecutar, no al leer esta guía.

## Mis informes: entrada opcional de IA, entrega determinista

Despliegue registrado el 13/10 para prueba y Recepción; las otras líneas
requieren autorización/configuración. `abrir_mis_informes()` abre la misma lista que el menú **Mis informes**. No recibe
PAC/CI/teléfono/IDs del modelo ni devuelve estudios o PDFs a Gemini. Solo se declara
en líneas autorizadas para autoconsulta. El paciente elige; el CRM y Resultados
revalidan identidad, publicación, versión y vigencia antes de entregar el PDF.
Interpretación de resultados y consultas médicas siguen derivándose a humanos.
En SUGERIR aparece «Abrir lista de informes»; RESPONDER ejecuta la misma acción.
Detalles, límites de identidad, privacidad y activación: [informes por WhatsApp](informes-por-whatsapp.md).
