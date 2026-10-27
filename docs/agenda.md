# Agenda: responsabilidades y recorridos

La agenda clínica es **ScriptCase + MySQL**, conectada con **FileMaker**.
El calendario `Actividades` del CRM organiza seguimientos internos; no es esa
agenda. La antigua API FastAPI no participa en esta integración.

## Quién escribe qué

| Dueño | Datos y operación | Límite |
| --- | --- | --- |
| `AgendaService` | Catálogo, días y horas libres de MySQL | Ocupan citas `CREADO` y reservas `PENDIENTE`/`PAGADO`; usa `horasLibres`, no modifica la vista de ScriptCase |
| `AgendaReservasService` | Alta en `para_agendar`, comprobante y aviso de Telegram | Camino compartido por web, Flow y asistente; no crea ni modifica citas de `agenda_med` |
| `AgendaReservasCrmService` | Reservas del CRM y de la paciente del chat | Solo consulta; comprobantes con acceso y auditoría |
| `AgendaMedicosCrmService` | Administración de médicos, especialidades y casillas | Cuenta MySQL limitada, control de versión; no cambia código FileMaker de un médico existente |
| `HorarioFilemakerService` | Revisión/pendiente en PostgreSQL y aplicación del horario MySQL | Con integración activa, FileMaker edita y el CRM muestra; [contrato](filemaker-horarios.md) |
| `DirectorioService` | `PerfilMedico`, especialidad pública, foto, biografía y publicación | Agenda le pide actualizar ficha/precio/horario; no escribir sus tablas desde otro service |
| Conversaciones | `ReservaChat`, QR, comprobante y mensaje al paciente | [Reserva y pago por chat](reservas-pago-chat.md); no segunda agenda ni confirmación de Caja |
| Actividades | Seguimiento de reservas | [Conciliación y campanita](reservas-actividades.md); no traslada ni cancela citas clínicas |

Las dependencias Nest directas están en `agenda.module.ts` (Directorio y Storage),
`asistente.module.ts` (Agenda y Storage), `conversaciones.module.ts` (orquestación)
y `actividades.module.ts` (Agenda, Conversaciones, Clientes y Líneas). Antes de
añadir una dependencia, mirar esos imports y sus llamadas, no inferirla del menú.

## Cuentas, cupos y acceso

Hay cuentas MySQL separadas para catálogo público, reserva, consulta clínica y
administración. `CuposAgenda` limita la concurrencia por cuenta; las lecturas de
una cuenta que escribe usan `consultar()`, sin tomar un candado de escritura.
Mantener TLS y permisos mínimos. Configuración por nombre en `.env.example`.

Las capacidades `puedeVerAgendaClinica` y `puedeEditarAgendaClinica` distinguen
lectura clínica de edición. El endpoint de reservas de una conversación aplica
el acceso a ese chat. Público: catálogo/reserva/pago con límites propios; no
convertir los permisos del directorio público en acceso a datos de pacientes.

`/publico/agenda/dias` y `/disponibilidad` también los lee el CRM: el botón
«Cupos» del compositor del chat (frontend `cupos-medico`) ofrece las mismas horas
que la web, con el CORS del CRM y sin ruta duplicada. Solo lee; no reserva.

## Reserva, cita y pago son hechos distintos

1. Web, Flow o IA registran la reserva con el mismo service; revalidan cupo.
2. El CRM entrega el QR del médico cuando hay precio y QR disponibles. El
   comprobante entra como pago por verificar, no como confirmación de Caja.
3. Recepción carga la cita en FileMaker, que escribe `agenda_med`. La reserva
   `ATENDIDO` se muestra como «Confirmada»: no demuestra atención médica realizada.
4. En el contrato observado de FileMaker, anular marca `BORRADO`; cambiar deja
   la anterior `MODIFICADO` y crea otra `CREADO`. El CRM no debe inventar una
   escritura directa a esas citas.

El Flow dinámico `reserva-cita.v1` usa `AgendaFlowController`: firma Meta,
RSA-OAEP/AES-GCM y token ligado al teléfono del chat. No confundirlo con el
Flow anterior de **solicitud**. La IA propone la acción y el CRM valida/ejecuta;
véase [asistente](asistente-ia.md). El directorio es información pública, no la
fuente independiente de disponibilidad ni de precio de un médico enlazado.

## Ficha y horarios

`PerfilMedico.agendaMedicoId` enlaza la presentación pública. La foto del CRM
sale de esa ficha o de la URL pública versionada de la agenda (`fotoDelMedico`);
«Usar la de la agenda» la copia a la ficha. La consulta por código de FileMaker
une el historial de Servicios con el médico de agenda. Las páginas públicas de
especialidad se enlazan por `claveDeEspecialidad`.

Con `FILEMAKER_HORARIOS_ACTIVO`, el editor semanal está en FileMaker. Consultas
de 30 minutos por defecto y 15 cuando el rango lo requiere o se indica explícitamente.
La duración se guarda con los cupos en MySQL y la leen disponibilidad y reserva.
Mantiene revisiones monotónicas y reintento de la última instantánea;
conserva citas. No implementar reconsultas o traslado de reservas como parte
de ese flujo. La aceptación pendiente se detalla en [FileMaker](filemaker-horarios.md).

## Vacaciones y ausencias

ScriptCase y FileMaker no tienen vacaciones: `horarios` es semanal y
`vista_horas_libres` ofrece cualquier casilla sin cita. Las ausencias (vacaciones,
congreso) las guarda el CRM en `AusenciaMedico.agendaMedicoId` (= `medicos.medico_pk`),
las escribe `DirectorioService` y se cargan en Directorio → médico → pestaña
«Horario» (`POST/DELETE /agenda/medicos/:id/ausencias`, quien edita la agenda).
Desde que se guardan:

- `AgendaService.dias` quita esos días y trae `ausencias` con `vuelve`;
  `disponibilidad` de un día así responde `SIN_ATENCION` sin horas y con `ausencia`.
  Lo usan la web, el Flow, el botón «Cupos» y el asistente.
- `AgendaReservasService.reservar` rechaza la fecha con `HORA_NO_DISPONIBLE`
  antes de abrir la transacción MySQL (el mismo código de una hora ocupada:
  Flow y asistente ya saben ofrecer otra).
- El asistente recibe `noAtiende` en `buscar_medico`, `listar_medicos` y
  `ver_medico`, y la regla de no ofrecer esos días y decir cuándo vuelve.
- La ficha muestra cuántas citas `CREADO` y reservas `PENDIENTE`/`PAGADO` caen
  esos días (cuenta `crm_agenda_consulta`, solo cantidades). **No se mueven**:
  recepción las reprograma en FileMaker. El CRM no escribe `agenda_med`.

Límites: el formulario propio de ScriptCase y la carga en FileMaker no leen estas
ausencias. Una ficha web sin médico de agenda conserva sus ausencias por
`perfilMedicoId` (solo la landing); la migración `20261027150000` pasó las de
fichas enlazadas a su médico.

## Evidencia y validación

- Implementación: `src/modules/agenda/`; tests `agenda-cupos`,
  `agenda-reservas-crm`, `agenda-medico-citas`, `horario-filemaker` y sus
  integraciones. Buscar sus nombres con `rg --files src/modules/agenda`.
- Pruebas MySQL reales: `npm run test:agenda-mysql`, con su entorno descartable.
  Los dobles de MySQL no demuestran que permisos, SQL y datos reales coincidan.
- [Auditoría VPS](auditoria-agenda-vps-2026-10-06.md) y
  [contraste SQL](auditoria-agenda-sql-2026-10-06.md) conservan la investigación
  original. La implementación, Flows publicados y despliegues posteriores se
  documentan en [historial de octubre](historial/estado-2026-10.md).
