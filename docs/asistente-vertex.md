# El asistente con Vertex (Gemini): lo que está listo y lo que falta

Estado: **el catálogo de herramientas está hecho y probado; el modelo no está
conectado.** Nada llama a Vertex todavía y no hay credenciales en el servidor.

## Si llegas a este archivo en otra sesión, lee esto primero

El asistente está construido **por la mitad que no depende del proveedor**, y
esa mitad está probada: 23 pruebas que corren sin credenciales, sin red y sin
Vertex. Lo que falta es el adaptador del modelo y dos cosas que son de la
clínica, no del código.

**No empieces por conectar Vertex.** El orden está al final de este archivo y
el primer punto no es código.

Tres reglas que ya están encodadas y que conviene no deshacer. Cada una tiene su
prueba:

1. **El modelo nunca decide una escritura.** `permitirEscritura` lo pasa quien
   llama. Si lo abres «para probar», el modelo puede reservar solo.
2. **`automaticFunctionCalling` va apagado.** Con el automático, el SDK ejecuta
   la función sin pasar por el despachador y la regla 1 deja de existir.
3. **El teléfono sale de la conversación, no de los argumentos.** Si entra como
   parámetro, el modelo puede reservar a nombre de otro número.

## Lo que ya existe

`src/modules/asistente/herramientas.ts` — el catálogo. Seis herramientas, cinco
de lectura y una de escritura, cada una envolviendo `AgendaService` o
`AgendaReservasService`, que ya están probados contra MySQL real.

| Herramienta | Qué devuelve | Escribe |
|---|---|---|
| `listar_especialidades` | Las especialidades de la clínica | no |
| `listar_medicos` | Médicos de una especialidad, con precio y modalidad | no |
| `ver_medico` | Un médico con su especialidad, precio y horario | no |
| `dias_con_cupo` | Los próximos días con alguna hora libre | no |
| `horas_libres` | Las horas libres de un día | no |
| `reservar` | La reserva, o que la hora ya no está | **sí** |

`declaracionesParaElModelo()` las entrega con la forma exacta que pide
`tools: [{ functionDeclarations }]`. Las declaraciones y el despacho salen de la
MISMA lista: no hay dos sitios que puedan divergir.

13 pruebas en `herramientas.spec.ts`, **sin modelo**. Si algún día cambia el
proveedor, siguen valiendo.

## El SDK, comprobado en octubre de 2026

El paquete es **`@google/genai`**, no el antiguo `@google-cloud/vertexai`. Y el
nombre del producto cambió: la documentación lo llama *Gemini Enterprise Agent
Platform* y el backend se elige con **`enterprise: true`**, no con el
`vertexai: true` que se encuentra en los tutoriales viejos.

```ts
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({
  enterprise: true,
  project: process.env.GOOGLE_CLOUD_PROJECT,
  location: process.env.GOOGLE_CLOUD_LOCATION,
});
```

O por entorno: `GOOGLE_GENAI_USE_ENTERPRISE=true`, `GOOGLE_CLOUD_PROJECT`,
`GOOGLE_CLOUD_LOCATION`, y `new GoogleGenAI()` sin argumentos.

Node 20 o más; **desde la versión 3.0.0 del SDK, Node 22**. El servidor corre
22.23.1, así que no hay problema.

Autenticación: credenciales por defecto de la aplicación. En el servidor va una
cuenta de servicio con el rol mínimo de Vertex, **no** `gcloud auth
application-default login`, que es para una máquina de desarrollo.

## La bandera que hay que apagar

```ts
config: { automaticFunctionCalling: { disable: true } }
```

**No es opcional.** Con el automático activado, el SDK ejecuta la función que el
modelo pide sin pasar por nuestro despachador, y entonces `permitirEscritura`
no existe: el modelo podría reservar por su cuenta. Es el valor por defecto más
peligroso de esa librería para este caso. El bucle se conduce aquí: se lee
`response.functionCalls`, se llama a `HerramientasAsistenteService.ejecutar()`,
y se devuelve el resultado como `functionResponse` en el historial.

`toolConfig.functionCallingConfig` admite un modo y `allowedFunctionNames`: sirve
para acotar qué puede pedir el modelo en cada turno —por ejemplo, prohibir
`reservar` mientras falten el nombre o el CI—.

## MCP: no, y por qué

El SDK trae `mcpToTool()`, marcado **experimental**. No aporta nada aquí:

- MCP existe para exponer herramientas **a través de un límite de proceso**, a
  clientes cualesquiera. Las nuestras son funciones del mismo NestJS. MCP
  añadiría un servidor y un protocolo para llamar a una función que está al
  lado.
- Hay un problema reportado al mezclar `mcpToTool(client)` con
  `functionDeclarations` en el mismo arreglo `tools`, que es justo lo que
  haríamos.
- Y arrastra la ejecución automática, que es lo que acabamos de apagar.

Si algún día otra cosa —un panel, un agente externo— necesita estas
herramientas, ahí MCP sí tiene sentido: el catálogo ya está separado del
transporte, así que envolverlo sería directo.

## El bucle

`conversacion-asistente.ts` conduce el turno y es donde viven las reglas. No
sabe que existe Vertex: recibe un `ModeloConversacional` (`modelo.port.ts`), que
es la única frontera con el proveedor.

| Regla | Qué impide |
|---|---|
| Tope de 5 vueltas | Que un modelo pidiendo herramientas en bucle se coma el presupuesto |
| `reservar` fuera de `herramientasPermitidas` hasta tener nombre y CI | Confiar en que no la pida. En Vertex es `allowedFunctionNames` |
| El resultado vuelve al modelo tal cual, acierto o error | Que un `HORA_NO_DISPONIBLE` corte el turno en vez de ofrecer otra hora |
| Un texto vacío no se publica | Publicar un turno perdido como si fuera una respuesta |
| Una excepción de la herramienta se le cuenta al modelo | Que se rompa el turno, y que un «MySQL no responde» viaje al modelo |

Lo que falta para conectarlo es **un adaptador**: una clase que implemente
`ModeloConversacional.responder()` llamando a `@google/genai`. Traduce el
historial a `contents`, pasa `declaracionesParaElModelo()` en
`tools: [{ functionDeclarations }]`, pone `allowedFunctionNames` con
`herramientasPermitidas`, apaga `automaticFunctionCalling`, y devuelve
`response.functionCalls` o el texto. Son unas treinta líneas y es lo único que
necesita credenciales.

## El quinto camino: ya está resuelto

`esperandoRespuesta` ES la pestaña «Sin responder». La respuesta del asistente
tiene que salir por `guardarMensajeAutomatico` de `ingesta-whatsapp.service.ts`,
que ya hace las tres cosas que hacen falta: toma el candado por conversación,
respeta la pausa si la paciente pidió una persona, y escribe el campo.

Y lo escribe en **`true`**, con la razón en el código: un automático no es una
respuesta, y ponerlo en `false` sacaba de «Sin responder» todo lo que entra un
fin de semana. **Un mensaje del asistente hereda esa regla**: contesta, y la
agente sigue viendo el chat pendiente. Si algún día se decide que una respuesta
del asistente sí cierra, es una decisión de la clínica y se cambia ahí, no en el
asistente.

`check:skills` lo sostiene: la lista de archivos que escriben ese campo es
cerrada (`ESCRIBEN_ESPERANDO_RESPUESTA` en `scripts/verificar-skills.mjs`). Un
camino nuevo rompe el build hasta que se anote, y anotarlo obliga a decidir si
va `true` o `false`. Probado en las dos direcciones.

## La imagen del horario: no hace falta

`ver_medico` ya devuelve `horarioInformativo` —«Martes: entre 10:00 y 12:00 ·
Jueves: entre 10:00 y 12:00»— construido desde las casillas por
`tarjetasDeMedicos`. En un teléfono eso se lee mejor que un recuadro de 6×2 cm,
se puede copiar y lo lee un lector de pantalla.

Si de todas formas se quiere la imagen, el coste es **una dependencia nativa**
(`sharp` o `@resvg/resvg-js`) en un servidor sin staging, y el único beneficio
es que se parezca al recuadro de la web. Mi recomendación es no pagarlo; la
decisión es de la clínica.

## Lo que falta, en orden

1. **Las descripciones.** Qué hace cada especialidad, qué incluye una consulta,
   cuánto cuesta. Hoy no existen en ninguna base, y es lo que decide si acierta:
   una prueba independiente sobre 500 conversaciones midió 38% de resolución
   frente al 76% anunciado, y la diferencia era la base de conocimiento.
2. **Las fichas web de los 23 médicos con horario**, para que el asistente tenga
   de dónde leer su presentación.
3. **La imagen del horario.** `medicos.horario_html` ya existe y el CRM lo
   regenera desde las casillas: se renderiza a PNG una vez por médico, se guarda
   en R2 y se manda como adjunto. Se guarda la `mediaKey`, **nunca la URL
   firmada** — caduca en una hora y ya rompió imágenes dos veces por dos puertas
   distintas.
4. **El bucle y el prompt del sistema**, con las reglas que ya están escritas en
   las descripciones de las herramientas.
5. **El quinto camino.** Un mensaje del asistente tiene que escribir
   `esperandoRespuesta` como las otras cuatro transacciones que crean un
   `Mensaje`, o la pestaña «Sin responder» empieza a mentir. El propio
   `schema.prisma` lo advierte.

## El comprobante del QR

Lo que el asistente **sí** puede hacer: leer la imagen del comprobante (el SDK
acepta una imagen en línea con su `mime_type`) y extraer monto, fecha,
referencia y banco. Después, código determinista compara eso contra lo que la
reserva espera.

Lo que **no**: confirmar el pago. Hoy lo hace una persona
(`promociones-chat.service.ts`: `confirmar`, `pedirOtroComprobante`, `anular`),
y `PAGADO` en la agenda significa «comprobante registrado», no «verificado».
El asistente ahorra la lectura, no el criterio: la agente ve «dice Bs 400, que
coincide; referencia 123456» y decide ella.

Esa es la diferencia que hace seguro todo lo demás: **el modelo nunca decide una
escritura; puede pedirla, y es código determinista el que comprueba sus
condiciones.**
