# IA en el chat: herramientas y límites (preparación, 7/10/2026)

**Estado: no hay IA.** Este documento fija, antes de escribir una línea de ella,
QUÉ podrá consultar y hacer, con QUÉ código ya existente y bajo QUÉ reglas. Las
condiciones médicas para que conteste sola están en
[atención humana → «Antes de activar la IA»](atencion-humana.md#antes-de-activar-la-ia-requisito-obligatorio):
hasta cumplirlas, la IA **solo prepara borradores** que envía una persona.

## Principio

La IA no tiene acceso propio a nada. Cada herramienta es un método de un
service que **ya existe y ya tiene pruebas**, llamado con los mismos permisos y
validaciones que la pantalla o la web. Si una herramienta necesita algo que
ninguna pantalla hace, primero se construye para la pantalla.

## Herramientas, por fase

### Fase 1 — leer (borradores)

| Herramienta | Service existente | Qué devuelve | Datos de pacientes |
|---|---|---|---|
| Especialidades | `AgendaService.especialidades` | Las de la agenda con médicos activos | No |
| Médicos de una especialidad | `AgendaService.medicos` | Nombre, modalidad (en línea / a solicitud), horario informativo, precio | No |
| Días con horas libres | `AgendaService.dias` | Próximos 30 días con cupo | No |
| Horas libres de un día | `AgendaService.disponibilidad` | Horas reservables (`horasLibres`: solo ocupan citas vigentes) | No |
| Reservas de la paciente del chat | `AgendaReservasCrmService.deConversacion` | Sus próximas reservas, por su teléfono | Sí: solo las suyas, con el alcance del chat |
| Promociones vigentes | `PromocionesChatService.paraMenu` / `porId` | Las publicadas, con precio y condiciones | No |
| Ficha pública de un médico | `DirectorioService.medicoPublico` | Biografía, especialidades (solo publicadas) | No |

Todas leen por las cuentas y cachés de siempre (`CuposAgenda`, TTL de 30 s del
catálogo público): una IA que pregunte mucho no tumba la agenda.

### Fase 2 — actuar, siempre con confirmación de la paciente

| Acción | Service existente | Regla |
|---|---|---|
| Reservar una hora | `AgendaReservasService.reservar` | Solo tras mostrar médico, fecha, hora y precio y recibir un «sí» explícito. La hora se vuelve a comprobar dentro de la transacción; si se ocupó, se ofrece otra |
| Ofrecer una promoción | `enviarTarjeta` (ingesta) | La misma tarjeta del menú; nunca un precio redactado por la IA |
| Pedir una persona | `registrarSolicitudAtencion` | Ante cualquier duda. Es la salida por defecto |

**No hay fase para**: diagnosticar, interpretar resultados, recomendar
tratamientos, prometer precios o descuentos fuera de lo publicado, anular o
cambiar citas (eso se hace en FileMaker), ni confirmar pagos (caja).

## Reglas que el código ya hace cumplir

- **Un solo punto de salida**: todo mensaje automático pasa por
  `guardarMensajeAutomatico`, que se calla si el chat espera a una persona o
  está pausado. Una IA que envíe por otro camino reintroduce el fallo que esa
  función evita.
- **La emergencia la declara la paciente** (menú o frase cerrada) y suena a
  todos; la IA no la descarta ni la responde por su cuenta.
- **El precio y el horario salen de la agenda**, nunca del texto de la IA.
- **Las reservas web escriben exactamente como ScriptCase** (`para_agendar`,
  PENDIENTE): recepción las ve en «Reservas» y las confirma en FileMaker.

## Cómo encaja con la agenda de la clínica

Comprobado en el binlog de la agenda (4/6–7/10/2026):

1. La reserva (web, ScriptCase o, mañana, la IA) entra en `para_agendar` como
   `PENDIENTE` y avisa por Telegram.
2. Recepción la carga en **FileMaker**, que escribe la cita en `agenda_med`
   (`CREADO`) por ODBC desde la clínica.
3. Recepción marca la reserva `ATENDIDO` («Confirmada» en el CRM): ya está en la
   agenda; no significa que la paciente fue atendida.
4. FileMaker no borra: anular = `BORRADO`; cambiar = la vieja `MODIFICADO` y una
   nueva `CREADO`. Por eso solo `CREADO` ocupa una hora.

Una IA que reserve entra por el paso 1, igual que la web: no escribe
`agenda_med`, no toca FileMaker.
