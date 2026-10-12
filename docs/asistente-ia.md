# El asistente de IA (Gemini en Vertex)

Estado al 10/10/2026: **construido, probado y desplegable apagado.** Solo falta
conectar la cuenta de Google Cloud (paso a paso más abajo) y encenderlo por línea
desde el CRM. Sin esas credenciales, nada llama a Google y cada línea funciona
exactamente como antes.

Reemplaza a `asistente-vertex.md` (9/10), que describía la mitad sin modelo. Tres
cosas de ese documento resultaron **incorrectas al comprobarlas contra el SDK y la
documentación de Google**; están corregidas aquí y en el código:

| Lo que se había supuesto | Lo que es | Consecuencia si no se corregía |
|---|---|---|
| Usar `allowedFunctionNames` para quitarle `reservar` al modelo | Solo vale en modo `ANY`, que lo obliga a llamar SIEMPRE a una función | No contestaría nunca con texto. Ahora se le declaran solo las herramientas permitidas |
| Reconstruir lo que pidió el modelo desde nombre y argumentos | Gemini 3 firma su razonamiento (`thoughtSignature`) y rechaza con 400 la vuelta siguiente sin esa firma | Fallaba la primera vez que el modelo usara una herramienta. Ahora su contenido vuelve intacto (`crudo`) |
| Modelo Gemini 2.5 / SDK 3.0 | Los 2.5 dejan Vertex el **20/10/2026**; el SDK vigente es `@google/genai` 2.28.0 (Node ≥ 20) | Habría dejado de funcionar en diez días. Ahora `gemini-3.5-flash`, por variable |

## Qué hace

**En Ventas (y en cualquier línea donde se encienda), con tres modos:**

| Modo | Qué pasa | Para qué |
|---|---|---|
| Apagado | Nada. La línea como siempre. | — |
| **Sugerir** | Prepara una respuesta encima de la caja de texto del chat. La agente la lleva a su caja («Usar y revisar»), la corrige y la manda ella. Puede proponer además la tarjeta de una promoción o la imagen del horario de un médico, que salen con un toque. **No le escribe a nadie ni cambia nada del chat.** | Empezar. Es lo que exige «Antes de activar la IA» ([atención humana](atencion-humana.md)) mientras la clínica no apruebe su criterio. |
| **Responder solo** | Contesta lo comercial e informativo: precios, promociones, médicos, horarios, cupos, estado de su pago. Manda la tarjeta de la promoción (con «Pagar ahora») y la imagen del horario. Lo médico, las quejas, las posibles urgencias y lo dudoso los pasa a una persona en «Atención». | Fuera de horario y en picos. **No se puede encender sin el criterio de la clínica** (ver abajo). |

**La lectura del comprobante** (se enciende aparte, por línea): cuando la paciente
manda la foto o el PDF de su pago, el asistente lee monto, fecha, número de
operación, banco y a nombre de quién, y el CRM lo compara con lo esperado. En el
bloque del pago aparece «Coincide con lo esperado» o «Hay algo que revisar», con cada
punto: «Dice Bs 250; se esperaba Bs 280», «A nombre de Juan Quispe, no de Clínica
Montalvo SRL», «Es del 01/10: anterior a cuando se le mandó el QR», «La operación
778899 ya llegó en otro pago: puede ser un comprobante reutilizado». **Confirmar
sigue siendo de una persona**: el asistente ahorra leer con lupa, no el criterio.

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
consultó algo de la clínica; sin ninguna consulta, sigue pasando a una persona. A una paciente
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
Paz y «hoy» también (`fechaCivilClinica`). De cada fila solo la hora y el nombre: ni carnet, ni
teléfono, ni pago.

**Qué hace el modelo y qué no.** Elige el día y si quiere la `LISTA` o el `RESUMEN`
(`mi_agenda`, atada al médico por el contexto: no tiene parámetro de médico). **Al modelo vuelven
solo cantidades**; los nombres no pasan por el proveedor. La imagen y el texto los arma el
código (`agenda-medico-imagen.ts`: mismo SVG→PNG con resvg y la Poppins que el horario; el total
en la cabecera, los tres recuadros por estado, las citas separadas en mañana y tarde con una franja
de color por estado —[muestra](imagenes-whatsapp/agenda-medico.png)—; clave de R2 = huella del
dibujo, en `asistente/agenda-medico/`) y **el texto del modelo se descarta** cuando
ya se mandó el listado. Si el modelo afirma horas o cantidades sin haber consultado, no sale y el
chat pasa a una persona. Sin R2, el listado sale entero en texto.

**Reglas de este camino** (cada una con su prueba, comprobada rompiéndola):

- Solo en **«Responder solo»**: el borrador de «Sugerir» lo vería una agente de ventas.
- Sin filtro de entrada ni herramientas de ventas: a un médico solo se le declaran `mi_agenda` y
  `pasar_a_persona`; a una paciente, nunca `mi_agenda`.
- Si falla el modelo o la agenda, **no sale el acuse de las pacientes**: pasa a una persona.
- Sale por `guardarMensajeAutomatico` como todo lo del asistente: respeta la pausa y a la persona
  que esté atendiendo; la imagen es `repetible` (preguntar lo mismo a los diez minutos se contesta).
- El médico autorizado sigue siendo una «paciente» más en el CRM: su chat nace como cualquier otro
  (con su ficha y su lead de primer contacto). No se tocó la ingesta.

**Para encenderlo** (nada de esto se hizo; es de René):

1. Permisos de MySQL, una vez: `scripts/agenda/permisos-agenda-medicos.sh` (da a `crm_agenda_consulta`
   el nombre de la paciente de `agenda_med` y `medicos.codigo`; nunca el PAC). Sin él, la herramienta
   dice que no puede consultar y el médico pasa a una persona.
2. `AGENDA_VPS_CONSULTA=on` (ya está) y `ASISTENTE_IA=on` con la línea en «Responder solo».
3. Desplegar con la migración `20261010195626_acceso_medico_agenda` (aditiva: una tabla nueva).
4. Autorizar el número de un médico en su ficha y probar desde su teléfono, en la línea de prueba.

**Límites conocidos:** un médico que se desactiva en la agenda conserva su acceso hasta que alguien lo
quite; solo se ve un día por consulta (hasta tres días por mensaje); más de 30 citas en un día se
dibujan 30 y el resto está en el texto; las imágenes llevan nombres de pacientes y quedan en R2 como
cualquier adjunto del chat.

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

1. **El modelo nunca decide una escritura.** `reservar` existe en el catálogo pero
   nadie pasa `permitirEscritura`: las reservas las hace el Flow, que es determinista.
2. **Nunca manda el QR ni datos bancarios.** Para cobrar manda la TARJETA: la paciente
   toca «Pagar ahora» y el CRM le manda el QR con el monto congelado y registra el
   pago (`PromocionesChatService.iniciar`). Prueba de punta a punta en
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
   pausado, si lo último que mandó ella no es un texto, ni más de 15 veces por hora en
   un chat.

## Arquitectura

```
webhook → IngestaWhatsappService.procesarEntrante (sin cambios en su transacción)
            └─ en segundo plano: ¿la línea tiene asistente? → AsistenteChatService.programar
                                                                   │ espera 6 s (ráfagas), máx. 20 s
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
sudo -u crmapp npm run asistente:probar      # cuatro ✓ antes de seguir
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
# ASISTENTE_ESPERA_MS=6000
```

Comprobar con `sudo -u crmapp npm run asistente:probar` (cuatro ✓) y reiniciar
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
y `uso=conversar|clasificar|leer-comprobante`, que aparecen en la factura de Google.

## Lo que queda pendiente

- **Es de la clínica, no del código:** el conocimiento y el criterio de derivación
  (arriba), la orientación de emergencia del menú, y las fichas web de los médicos.
- **Probar contra Google de verdad.** Todo lo de aquí está probado con un modelo
  guionado (sin red). La primera conexión real es en la línea de prueba.
- **Reservar por el asistente.** El catálogo lo tiene; abrirlo es decidir que el
  modelo pueda pedir una reserva con nombre y CI. Hoy reserva el Flow.
- **Comprobantes de reservas** (QR del médico): la lectura cubre por ahora los pagos de
  promociones.
- **Audios.** El asistente ve «[Audio: no lo puedes escuchar]» y no contesta un audio
  suelto. Gemini puede transcribir; queda para después.
