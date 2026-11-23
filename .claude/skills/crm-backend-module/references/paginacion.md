# Paginación (obligatoria en todo listado)

> Parte de la skill `crm-backend-module`: lee antes su [índice](../SKILL.md).

Nunca devuelvas una tabla entera ni uses `take` fijo: hay 15.000+ clientes.

```ts
// dto/query-x.dto.ts
export class QueryClienteDto extends PaginationDto {
  @IsOptional() @IsEnum(CategoriaCliente) categoria?: CategoriaCliente;
}

// service
async findAll(query: QueryClienteDto, soloAgenteId?: string) {
  const where: Prisma.ClienteWhereInput = { /* … */ };
  const { skip, take } = calcularPaginacion(query);

  const [datos, total] = await this.prisma.$transaction([
    this.prisma.cliente.findMany({ where, orderBy: { updatedAt: 'desc' }, skip, take }),
    this.prisma.cliente.count({ where }),
  ]);

  return paginar(datos, total, query);
}
```

Respuesta: `{ datos, total, pagina, limite, totalPaginas }`.
Por defecto 25 por página, tope duro 100 (`common/dto/pagination.dto.ts`).
El frontend consume este sobre con `RespuestaPaginada<T>` y el átomo `<app-paginator>`.

**Ya no hay excepciones. El inbox era la última, y salió cara** (2026-08-27).
Devolvía las 500 conversaciones más recientes sin paginar y la UI filtraba por
pestañas y **buscaba** sobre ese conjunto. El fallo no era lentitud: una
conversación en el puesto 501 no aparecía al buscar a esa paciente por nombre,
así que la agente leía "sin resultados" y concluía que no estaba en el sistema.

Es la forma más peligrosa de este bug, porque **un corte se lee como un dato**.
Con un `take` fijo la pantalla no dice "hay más": dice "no hay". Y el WARN que
avisaba del tope estaba en el log del servidor, donde nadie lo mira.

Lo que costó arreglarlo, por si tienta repetirlo: mover las cuatro operaciones
—ordenar, filtrar por pestaña, filtrar por agente, buscar— a Postgres, más una
columna desnormalizada (`Conversacion.esperandoRespuesta`) porque "el último
mensaje es ENTRANTE" no se puede expresar en un `where` de Prisma. **Habría
sido más barato paginar desde el principio.**

### Abierta / cerrada: el número de cada pestaña es lo que aparece al pulsarla

**Cicatriz (2026-09-30):** «Sin responder» decía 427 y la clínica contaba bastantes
menos. No mentía sobre su definición: sin estado «cerrada», acumulaba todo lo que alguna
vez quedó sin contestar (201 chats sin movimiento en más de una semana, 83 en más de un
mes). Además el contador ignoraba el filtro por agente que sí aplicaba la lista, y el
Dashboard escribía su propia copia de la regla.

- **`Conversacion.cerradaEn` / `cerradaPorId`** = resuelta (el modelo de Intercom y Front).
  Las pestañas de trabajo (`TODAS`, `SIN_RESPONDER`, `SIN_ASIGNAR`, `MIS_CHATS`) solo
  muestran abiertas. `CERRADAS` es el archivo. Buscar en `TODAS` encuentra también las
  cerradas: buscar a una paciente nunca puede decir «no está».
- **Las definiciones viven UNA vez en `estado-conversacion.ts`** (`ABIERTA`,
  `SIN_RESPONDER`, `REABRIR`). El inbox y KPIs importan de ahí. Si escribes
  `esperandoRespuesta: true` a mano en un `where`, reintroduces el 427.
- **Lista, contadores y resumen de fila salen de los mismos constructores**
  (`whereAlcanceInbox` + `wherePestanas` en `consultas-inbox.ts`). Un filtro de vista
  nuevo va en `whereAlcanceInbox`, o el número y la lista vuelven a divergir. Los
  contadores van sin la búsqueda, a propósito.
- **Se reabre sola con actividad humana.** Las dos transacciones que escriben
  `esperandoRespuesta` por un humano (entrante en la ingesta, envío de la clínica y
  plantilla) esparcen `...REABRIR`. El acuse automático NO reabre.
- **Cerrar, reabrir y el barrido NO tocan `updatedAt`.** Van por `$executeRaw`, porque Prisma
  pone `updatedAt` en cada UPDATE, y es la hora que el inbox muestra y por la que ordena.
  Si lo tocaran, un chat de hace dos semanas diría «hace un momento».
- **`CierreInactividadService`** cierra cada 6 h lo que no tiene ningún MENSAJE en
  `CONVERSACIONES_CIERRE_DIAS` (30 por defecto). Mide por el último mensaje, no por
  `updatedAt`, que se mueve al asignar. `cerradaPorId` nulo significa que la cerró el
  sistema.

### Atención humana: solicitud, prioridad y pausa de la automatización (2026-10-05)

Diseño completo en el [diseño de atención humana](../../../../docs/atencion-humana.md). Lo que no se puede olvidar al tocarlo:

- **El estado sale de fechas, no de una columna `estado`**: `atencionSolicitadaEn`
  (viva) y `atencionTomadaEn` (en atención). Las definiciones (`CON_ATENCION`,
  `ESPERANDO_HUMANO`, `EN_ATENCION`, `ORDEN_ATENCION`) y la prioridad
  (`prioridadDeMotivo`) viven en `modules/conversaciones/atencion-humana.ts`. El orden de
  `enum MotivoAtencion` ES la prioridad.
- **Nace en la ingesta, dentro de la transacción del mensaje** (`registrarSolicitudAtencion`),
  a partir de lo que `guardarRespuesta` correlacionó. Nunca del título visible ni de un id
  que no esté en nuestra oferta: `seleccionId` solo existe tras correlacionar.
- **`atencionTomadaPorId` no es `agenteId`.** En recepción la atención es compartida:
  tomar no asigna el chat. En comercial, tomar reclama del pool con la misma regla que
  contestar y nunca le quita un chat a otra agente.
- **La automatización se calla en tres puntos, y los tres hacen falta**: la pausa se
  lee dentro del candado de `guardarMensajeAutomatico` (`CANDADO_AUTOMATICOS`, el mismo
  que toma la solicitud), se vuelve a mirar justo antes de despachar (`sigueSinPausa`
  retira lo que ya se había guardado) y el barrido de reintentos no reenvía automáticos
  de un chat pausado. **Un camino nuevo que mande automáticos pasa por
  `guardarMensajeAutomatico`**, o la paciente que pidió una persona recibe una máquina.
- Resolver no levanta la pausa; solo `POST …/automatizacion/reanudar`, auditado y sin
  solicitud viva. Cerrar resuelve. El barrido de inactividad no cierra una solicitud viva.
- **Resolver y cerrar con la solicitud viva dejan constancia en `AuditLog`
  (`ATENCION_RESUELTA`) en la MISMA transacción** que borra la solicitud
  (`bloquearSolicitudViva` + `auditarResolucion`): la conversación solo guarda la viva, así
  que esa fila es el único registro de cuánto esperó y quién la atendió. No añadas una
  columna `resueltaEn`: la siguiente solicitud la borraría.
- **El texto libre solo cuenta si el mensaje ENTERO es una frase de la lista cerrada**
  (`esPedidoDePersona`, `esAvisoDeEmergencia`) y con la bandeja de interacciones encendida.
  No es un clasificador y no detecta urgencias: ver «Antes de activar la IA» en el diseño
  antes de ampliarla.
- **`CRITICA` = `EMERGENCIA`, y solo la DECLARA la paciente** (botón del menú o frase
  entera). Está primera en el enum: la migración usó `ADD VALUE … BEFORE`, porque el
  `ADD VALUE` que genera Prisma la pone al final y la emergencia quedaría detrás de una
  revisión. Una emergencia suena a todos los que ven la línea (`notificarEntrante` con
  `critica`), también a quien la silenció.

### Menú de atención (2026-10-05)

Diseño en [menu-atencion](../../../../docs/menu-atencion.md). `modules/menu-atencion` es el
único dueño de `MenuAtencion`; la ingesta lo lee con `activoDe`. Lo que no se puede olvidar:

- **Tipos en código, contenido de la clínica**: ningún texto para la paciente tiene
  valor por defecto (sin orientación no hay opción de emergencia; sin promociones
  cargadas no hay opción de promociones). `erroresDelMenu` valida al guardar Y al leer.
- **Una selección se interpreta con el menú de HOY** (`accionDeSeleccion`) y solo si
  `guardarRespuesta` la correlacionó con nuestra oferta. Opción retirada → `REVISION`.
- **El menú es una oferta con `origen: 'MENU_ATENCION'`**: sin eso, el segundo toque en la
  misma lista era `DUPLICADA` y «Hablar con una persona» después de «Horarios» se perdía en
  silencio. Y solo un toque a una oferta así (`ResultadoRespuesta.deMenu`) dispara
  respuestas del menú: un `TALK_TO_HUMAN` de una campaña no recibe su confirmación.
- Lo que se contesta solo respeta la pausa y exige oferta vigente; la confirmación y la
  orientación de emergencia no (`respetaPausa: false`), con ventana anti-repetición.
- En la línea comercial, cuando el menú sale, el acuse fuera de horario no sale; si el menú
  no sale (conversación en curso), el acuse funciona como siempre.
- La opción «Promociones» **lee las promociones publicadas para WhatsApp** del módulo
  Promociones (`PromocionesChatService.paraMenu`): sin ninguna, la opción no se muestra. El
  menú ya no guarda una lista propia.

### Promoción en el chat y pago por QR (2026-10-06)

Diseño en [pagos-promocion](../../../../docs/pagos-promocion.md). Lo que no se puede olvidar:

- **`PromocionesChatService` es el único dueño de `PagoPromocion`**; la venta la crea
  `VentasService` (con `clientRequestId` por pago: confirmar dos veces no cuenta dos) y el lead
  lo anota `LeadsService`. `CobrosService` es el único dueño de `CobroLinea`.
- **Nunca «pagado» sin una persona**: PENDIENTE → COMPROBANTE_ENVIADO (sube a «Atención» con
  `COMPROBANTE_PAGO`) → CONFIRMADO al verificarlo. Un pago abierto por conversación, bajo
  `CANDADO_AUTOMATICOS`; el comprobante se marca con compare-and-set (`registrarComprobante`).
- **La tarjeta es una oferta `origen: 'PROMOCION'`** con su `promocionId` dentro del sobre
  cifrado: solo un toque a NUESTRA tarjeta inicia un pago. «Pagar ahora» responde aunque el
  chat esté pausado; si hoy no se puede cobrar, pasa a «Atención» y no se inventa nada.
- **El QR sale de R2 como un adjunto** (URL firmada): no hay ruta pública para él.
- **Confirmar copia el comprobante a `comprobantes/<agente>/`**: es la única carpeta que
  `VentasService` acepta como respaldo propio. Sin la descarga terminada, 409.

### Asistente de IA en el chat (2026-10-10)

Diseño en [asistente-ia](../../../../docs/asistente-ia.md). Lo que no se puede olvidar:

- **El modelo elige herramientas; los datos salen de ellas.** El catálogo
  (`modules/asistente/herramientas.ts`) es cerrado: una herramienta nueva es una función
  sobre un service que ya existe, con su prueba sin modelo. `escritura` exige
  `permitirEscritura` del llamador Y el `PuertoReservas` de la conversación; `mensaje` no se
  ejecuta en el bucle: queda como acción y la manda `AsistenteChatService`.
- **`reservar` (15/10) no escribe en el bucle**: comprueba (nombre y CI que ELLA escribió,
  `datosNoDichos`; hora libre en la agenda; ninguna reserva esperando pago) y deja la acción
  `RESERVA`. La registra `AsistenteChatService.reservarCita` al terminar el turno, con el
  celular del chat, y el texto del modelo se descarta: el mensaje y el QR los arma
  `registrarReservaDeChat`, el mismo del Flow. Solo en «Responder solo», en
  `ASISTENTE_RESERVAS_LINEAS` (falla cerrado) con interacciones, y con celular de Bolivia.
- **El estado de una cita en curso sale de la traza, no del texto del modelo**: la traza guarda
  `medicoId`/`fecha` de las herramientas de la agenda y `reservaEnCurso` la lee. Con ella, la
  duda del filtro no deriva (`decidirTriajeEnReserva`; lo médico sí) y el modelo puede empezar
  a la vez que el filtro: solo vale si el filtro confirma. Nada adelantado puede escribir.
- **Nunca el QR ni datos bancarios desde el modelo**: cobrar una promoción es mandar la
  tarjeta (el QR sale del toque a «Pagar ahora»); el QR del médico sale con la reserva.
- **Lo médico no llega al modelo que redacta**: lo decide `decidirTriaje` sobre la
  clasificación, que es código y se prueba en la tabla entera. `POSIBLE_URGENCIA` es
  ALTA; CRÍTICA sigue siendo solo la que declara ella.
- **Lo que manda el asistente sale por `IngestaWhatsappService`** (`responderComoAsistente`,
  `tarjetaDesdeAsistente`, `imagenDesdeAsistente`, `derivarDesdeAsistente`), que pasa por
  `guardarMensajeAutomatico` con `asistente: true`. La ingesta no inyecta al asistente:
  él se registra con `usarAsistente` (si no, sería un ciclo de dependencias).
- **Gemini 3 firma su razonamiento**: lo que pidió el modelo vuelve como su `Content`
  intacto (`crudo`), o la vuelta siguiente es un 400. Y a Vertex se le declaran SOLO las
  herramientas permitidas: `allowedFunctionNames` solo vale en modo `ANY`.
- **Si el modelo falla con una paciente: `respaldoSinAsistente` y además se deriva** (`DERIVADA_ASISTENTE`).
  El acuse solo sale fuera de horario; en horario no salía nada y la paciente quedaba en silencio (13/10).
- **Una llamada lenta a Gemini se duplica** (`conRespaldo` en `vertex/con-respaldo.ts`): vale porque
  `generateContent` no cambia nada. Nunca envuelvas así algo con efectos (enviar, reservar, escribir en
  la base): se haría dos veces. La copia puede ir a OTRO modelo solo si no hay razonamiento firmado de por
  medio (1.ª vuelta, transcribir, comprobantes); desde la 2.ª vuelta el turno sigue con el modelo que ganó
  (`responder({ modelo })`): la firma de Gemini 3 solo vale para él.
- **Una cita con un médico «a solicitud» es una solicitud de cita**: `pasar_a_persona` con motivo `CITA` →
  `SOLICITUD_CITA` y `TEXTO_SOLICITUD_CITA` (`motivoDeAtencion` en `asistente-chat.service.ts`). El dato del
  médico lo dice (`comoSeAgenda`); sin eso el modelo derivaba una venta como si fuera una duda (15/10).
- **Un médico autorizado es otra conversación** (`AsistenteChatService.atenderMedico`): su número
  sale de `AccesoMedicoAgenda` (lo escribe SOLO `AccesoMedicoAgendaService`, ADMIN+, auditado en la
  misma transacción) y el médico del que se habla sale de ese número, **nunca de un parámetro de la
  herramienta**. Al modelo vuelven cantidades, no nombres de pacientes; la imagen y el texto los arma el
  código (`agenda-medico-imagen.ts`) y el texto del modelo se descarta. Solo en «Responder solo». Una
  herramienta nueva para médicos lleva `soloMedico` y se prueba con la paciente (no debe verla).
  **Un médico no se pausa** (`registrarSolicitudAtencion(…, { pausar: false })`, y el turno no mira la
  pausa con él) y **lo que le sirve el asistente lo saca de «Sin responder»** (`resuelve`, solo en
  `guardarMensajeAutomatico`): la pausa y «Sin responder» existen para PACIENTES; no extiendas
  ninguna de las dos excepciones a una paciente.
- **Una nota de voz es un texto más** (`EscuchaAudiosService`, 12/10): se transcribe una vez,
  se guarda en `Mensaje.transcripcion` y entra por el MISMO filtro y las mismas herramientas.
  Si no se entiende, texto fijo; nunca se adivina. Todo lo que decida NO contestar (un médico en
  «Sugerir») se decide ANTES de escuchar. Excepción autorizada el 17/10: la
  transcripción interna (`TRANSCRIPCION_AUDIO_LINEAS`) procesa nuevos audios para
  las agentes sin contestar. Cola durable y lock compartido con el turno; no
  altera la pausa ni concede acceso a herramientas médicas. Ver asistente-ia.md.
- **En SQL, `NOT (estadoEnvio = 'FALLIDO')` descarta los NULL**, que son todos los
  mensajes entrantes. Para excluir los no enviados: `OR: [{ estadoEnvio: null }, { estadoEnvio: { not: 'FALLIDO' } }]`.
  Lo cazó la prueba de integración del asistente; con `NOT` no contestaba nunca.
