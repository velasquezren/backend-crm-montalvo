# F06 — Envío durable, resultado desconocido e idempotencia (entrega 2 de 2)

9 de septiembre de 2026. Cierra el **despacho saliente**. La recepción durable
—persistir el webhook antes de procesarlo— queda fuera y se explica al final.
Sin cambios en reglas financieras, autorización ni sesión.

Nota de numeración: `auditoria-f06-etapa2.md` **no** es este documento. Aquel se
tituló así pero cubre la carrera del inbox, la sesión cruzada y la colisión de
Service Workers, que en el informe maestro son F07 y F09.

## Qué se buscaba y qué se encontró

La entrega 1 dejó escrito su propio límite: «un mensaje que no salió queda en
FALLIDO y una agente lo reintenta a mano». Al ir a automatizar ese reintento
apareció que la premisa no se sostenía: **FALLIDO no significaba siempre "no
salió"**.

`WhatsappCloudService.enviar()` devolvía `null` en tres situaciones que no se
parecen en nada, y el despachador las anotaba todas igual:

| Situación | ¿Llegó a la paciente? | Quedaba como |
| --- | --- | --- |
| Sin credenciales | No, seguro | FALLIDO ✔ |
| Meta respondió 4xx | No, seguro | FALLIDO ✔ |
| **Excepción de red / socket colgado** | **No se sabe** | FALLIDO ✘ |

El tercero es el que hace daño, y precisamente por hacer lo que la entrega 1
recomienda: la agente ve "No enviado", lo reenvía, y si el POST sí había llegado
la paciente recibe el mensaje dos veces. Es el mismo modo de fallo que ya
documenta la cabecera de `enviarMensaje` —«la agente veía un 500 sobre un mensaje
que ya aparecía en el hilo, y al reintentar lo duplicaba»— entrando por otra
puerta.

**Hallazgo no previsto: ninguna llamada a Meta tenía timeout.** `grep -rn
"AbortSignal\|timeout" src/common/whatsapp/` no devolvía nada. Un socket abierto
sin respuesta dejaba el despacho esperando indefinidamente en un proceso de un
solo núcleo — y es además el mecanismo que produce el caso incierto, así que las
dos cosas se arreglan juntas o ninguna.

## Reproducción antes del cambio

`src/common/fiabilidad/resultado-de-envio-desconocido.spec.ts`, escrito y
ejecutado **antes** de tocar el código, igual que en la entrega 1. Conduce los
tres desenlaces por la entrada real (`fetch` simulado: 4xx, rechazo de red, 200
sin id) y comprueba qué se escribe en la fila.

Resultado antes del arreglo: **11 de 12 fallando**.

Un detalle que conviene no repetir: el primer intento probaba el corte por tiempo
con un centinela de 60 ms contra un `Promise.race`. **No sirve** — el corte real
son diez segundos, así que el centinela gana siempre y el test queda verde por el
motivo equivocado. Los temporizadores falsos de Jest tampoco valen:
`AbortSignal.timeout` no usa el `setTimeout` global que Jest sustituye. Se
prueban en su lugar las dos mitades observables: que la petición viaja con señal,
y que un `TimeoutError` se traduce a INCIERTO con un motivo legible.

## Qué cambió

**`ResultadoEnvio` en vez de `string | null`** (`whatsapp-cloud.service.ts`).
`ENVIADO` con el id, `NO_SALIO` con motivo, `INCIERTO` con motivo. El reparto:
4xx y falta de credenciales son `NO_SALIO`; excepción de red, corte por tiempo y
**5xx** son `INCIERTO` (un 5xx no es un rechazo del cuerpo: Meta pudo aceptarlo y
perderlo después). Un **200 sin id** también es incierto, y es el peor caso, porque
Meta lo aceptó pero no dejó con qué correlacionar la vuelta.

**`AbortSignal.timeout` en las cinco llamadas** del servicio: 10 s para los
mensajes, 30 s para la descarga de media, que baja archivos y no JSON.

**`EstadoMensaje.INCIERTO`**, más `Mensaje.intentosEnvio` y `Mensaje.proximoIntento`
con su índice — migración `20260909210000_envio_incierto_y_reintento`. La UI lo
pinta como **"Sin confirmar"** en tono neutro, nunca como un fallo, con el aviso
explícito de no reenviarlo todavía.

**`biz_opaque_callback_data`.** Se manda el id de nuestra fila al enviar y Meta lo
devuelve en el webhook de `statuses` (*Status messages webhook reference*:
«only included if the business set a biz_opaque_callback_data value when sending
the message»). Es el único hilo que sobrevive a no recibir la respuesta HTTP:
`procesarEstadoMensaje` lo usa como segunda vía de correlación, adopta el id que
Meta revela y cierra el incierto **sin haber reenviado nada**. Un `sent` sobre una
fila INCIERTA la levanta a ENVIADO; un `failed` la baja a FALLIDO y entra al
barrido como cualquier fallo cierto.

**`ReintentoSalienteService`** — barrido cada minuto, tope 50, tandas de 5,
try/catch por elemento, `.unref()`, apagado bajo `NODE_ENV=test`. Mismo patrón y
mismos números que el barrido de recordatorios de Actividades, por el mismo
motivo: un núcleo y un pool compartido con las agentes.

**El duplicado del enum en el frontend.** `conversacion.model.ts` tenía
`EstadoEnvioMensaje` escrito a mano en vez de salir de `db-enums.ts`. Por eso
añadir `INCIERTO` **no rompió** el build del frontend: el estado nuevo caía en el
`@default` de las plantillas y se pintaba como un envío normal — justo la mentira
que ese estado viene a evitar. Ahora sale del enum generado.

## La regla que gobierna todo el cambio

**Solo se reintenta lo que consta que no salió.** Un INCIERTO no se reenvía
nunca por cuenta propia. Decidido explícitamente con el usuario el 9 de
septiembre, sobre tres opciones; la alternativa "reintentar siempre" se descartó
por aceptar duplicados en el WhatsApp de la paciente.

Tres puertas lo sostienen, y las tres tienen prueba:

1. **Reclamación con UPDATE condicionado** antes de despachar. Dos barridos
   solapados leerían la misma fila; el `where` exige que el turno siga vencido,
   así que de dos exactamente uno despacha. Mismo patrón que `agenteId: null` en
   `enviarMensaje`.
2. **La reclamación agenda el turno siguiente**, y el despacho va marcado
   `reintento: true`. Sin esa marca el despachador reagendaría desde cero cada
   vuelta y el backoff no crecería nunca: un mensaje muerto se reintentaría cada
   minuto para siempre.
3. **Se comprueba la ventana de 24 h antes de gastar el intento.** Fuera de la
   CSW, Meta rechaza el texto libre igual. La de 72 h del Free Entry Point no
   cuenta: solo habilita plantillas, nunca texto libre.

## Límites conocidos

- **Una plantilla fallida no se reintenta sola.** La fila guarda el texto ya
  compuesto, no el nombre ni los parámetros, así que el barrido no tiene con qué
  rearmarla — y mandarla como texto plano es exactamente lo que Meta rechaza
  fuera de la ventana, que es cuando se usan plantillas. Queda FALLIDO para una
  persona. Reintentarlas exigiría persistir nombre y parámetros: otra entrega.
- **La recepción durable NO está hecha.** El webhook sigue respondiendo 200 y
  procesando en `enSegundoPlano`: lo que se pierda procesando no se reintenta.
  La idempotencia de entrada sí existe desde antes (dedupe por wa msg id en
  `ingesta-whatsapp.service.ts`, clave única en `Lead`), pero durabilidad no es
  idempotencia. Es lo que queda abierto de F06.
- **El caso incierto que nunca recibe `statuses`** se queda en "Sin confirmar"
  para siempre. Es deliberado —es información honesta— pero no hay todavía una
  pantalla que los liste ni un plazo tras el cual se avise a alguien.
- **No se probó contra Meta real.** Todo el camino externo va con `fetch`
  simulado. Los valores de timeout (10 s / 30 s) son razonados, no medidos.
- **`biz_opaque_callback_data` ata la versión de la API.** La documentación
  advierte que se omite entero en v24; el repo va en v25. Bajar de versión rompe
  la correlación en silencio.

## Verificación

- **499 pruebas unitarias en 32 suites** (eran 487 en 31): +12 del barrido, +12
  del spec de reproducción, menos las reescritas por el cambio de contrato.
- `npm run build` completo (check:skills + compilación + check:build) y
  `npm run test:build`: **9/9**.
- Frontend: typecheck de `tsconfig.app.json`, **80 pruebas en 9 suites**, y
  `npm run build` (check:tipos + check:skills + ng build).
- **Las pruebas nuevas muerden.** Se comprobó a propósito quitando la
  concurrencia acotada del barrido (`Promise.all` sobre el lote entero): la
  prueba del tope de cinco falla, y vuelve a pasar al restaurarla. Es el mismo
  método con el que se validó la regla de `check:skills` en la entrega 1.
- **Sin suite de integración.** No hay PostgreSQL levantado en esta máquina
  (`pg_isready -p 5433` sin respuesta), así que
  `test:integracion` no se ejecutó y la migración **no se aplicó a ninguna base**.
  Queda pendiente antes de desplegar.

## Rollback

Revertir el commit devuelve el código, pero **la migración añade un valor a un
enum de PostgreSQL y eso no se deshace con un `DROP`**. Si hay que volver atrás
con la migración ya aplicada, el orden es: revertir el código primero, y dejar la
columna y el valor del enum donde están —son aditivos y no molestan— en vez de
intentar quitarlos. Cualquier fila que haya quedado en INCIERTO hay que decidirla
a mano antes de revertir: el código viejo no sabe leer ese estado y la UI lo
pintaría como un envío normal.

No se desplegó ni se consultó producción. Sigue pendiente de producción la
migración de F05 (`20260907180000_sesion_revocable`); esta va después.
