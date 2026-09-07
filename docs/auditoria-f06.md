# F06 — Rechazos fuera de la petición (entrega 1 de 2)

7 de septiembre de 2026. Alcance: **solo capturar los fallos**. La recepción y
el despacho durables —estado persistente, reintento controlado, idempotencia—
son la entrega 2 y no están hechos. Sin cambios en reglas financieras, sesión,
autorización, dependencias, migraciones ni frontend.

Continúa F01–F05, que quedan cerrados. Nota de numeración: el archivo
`auditoria-f06-etapa2.md` se tituló F06 pero cubre otra cosa —carrera del inbox,
sesión cruzada y colisión de Service Workers—, que en el informe maestro son
**F07 y F09**. Este documento es el F06 del informe maestro.

## Qué se buscaba y qué se encontró

Node aborta el proceso ante una promesa rechazada sin manejar. Dentro de una
petición HTTP eso no importa: el filtro global de excepciones la convierte en un
500. Pero el backend dispara trabajo con `void` a propósito, y ahí no escucha
nadie.

Se revisaron los **doce** sitios que disparan trabajo sin esperarlo, no los tres
que citaba la auditoría. De los doce, nueve resultaron ya protegidos por dentro
y **tres dejaban escapar el rechazo de verdad**:

| Sitio | ¿Escapa? | Por qué |
| --- | --- | --- |
| `actividades.service.ts` — barrido de recordatorios | **Sí** | El `findMany` que abre el barrido está fuera de todo try/catch. El try/catch por elemento de `notificarRecordatorio` protege el interior del bucle, al que nunca se llega. Corre cada 5 minutos, para siempre. |
| `tipo-cambio.service.ts` — sincronización automática | **Sí** | El try/catch que rodea el `fetch` al espejo del BCB termina **antes** de las dos consultas a la base. Dos disparos: uno al arrancar el módulo y otro cada 6 horas. **No lo citaba la auditoría.** |
| `conversaciones.service.ts:755` y `:890` — envío a Meta | **Sí** | Vía `registrarResultadoEnvio`, cuyo `updateMany` rechaza si la base no responde. |
| `ingesta-whatsapp.service.ts` ×3 — media, acuse, pedido de datos | No | `traer`, `responderFueraDeHorario` y `pedirDatosDelPaciente` tienen try/catch completo. |
| `conversaciones.service.ts:926` — acuse de lectura | No | `whatsapp.marcarLeido` atrapa todo y devuelve void. |
| Webhooks de WhatsApp y de Lead Ads | No | Cada elemento del lote va en su propio try/catch; no queda ningún `await` fuera. |
| `conversaciones.gateway.ts:38` y `:79` | No | Ya tienen `.catch()` propio, y hacen algo más específico que registrar. |

El de tipo de cambio es el peor de los tres y es el que la auditoría no vio. El
disparo del arranque significa que un PostgreSQL que todavía no acepta
conexiones cuando systemd levanta el backend tumbaba el proceso; systemd lo
relevantaba por `Restart=always` y volvía a pasar. Es el mismo modo de fallo
—servicio `active` que en realidad no sirve— que ya documentan la trampa 1 del
salto a Prisma 7 y el comentario de `rootDir` en `tsconfig.json`.

## Reproducción antes del cambio

`src/common/fiabilidad/rechazos-fuera-de-peticion.spec.ts` se escribió y ejecutó
**antes** de tocar el código. Inyecta el fallo realista —Prisma rechazando con
`Timed out fetching a new connection from the connection pool`, que no necesita
que la base caiga entera: basta el `max_connections` agotado o un reinicio de
PostgreSQL durante un despliegue— y conduce cada camino por su entrada real:
`onModuleInit` con `NODE_ENV` de producción y temporizadores falsos para los dos
servicios de fondo, y el despachador con su `updateMany` rechazando.

Resultado antes del arreglo: **5 de 6 fallaban**, los tres caminos con el error
inyectado escapando de la suite.

Un detalle que costó y conviene no repetir: el primer intento montaba un
`process.on('unhandledRejection')` dentro del test para contar los escapes.
**No funciona.** Jest ejecuta el código bajo prueba en un contexto `vm`, así que
el evento no llega al `process` del test: la lista volvía vacía mientras Jest sí
reportaba el rechazo. Quien detecta es Jest, que falla la suite entera cuando una
promesa rechaza sin manejar durante el archivo. Por eso el spec no tiene una
aserción explícita de "no escapó" y sí una nota explicando por qué: si alguien
quita un `enSegundoPlano` de esos sitios, los tests fallan aunque sus `expect`
sigan pasando.

## Qué cambió

**`src/common/fiabilidad/en-segundo-plano.ts`** (nuevo). Un helper:

```ts
enSegundoPlano(contexto, logger, () => trabajo())
```

Tres decisiones que no son de estilo:

1. **Recibe una función, no una promesa ya construida.** Así también atrapa lo
   que lance *antes* de que la promesa exista; pasándole `this.a(b)` ya evaluado,
   una excepción al construir el argumento sería sincrónica y saldría disparada
   por el hilo que se quería proteger.
2. **Devuelve la promesa aunque los llamadores la descarten**, para que una
   prueba pueda esperarla. Sin eso habría que sembrar la suite de esperas por
   tiempo, que es como se construye una suite intermitente.
3. **Nunca va dentro del método que hace el trabajo, sino en el punto donde se
   dispara.** `TipoCambioService.sincronizarAutomatico` es el ejemplo: lo llama
   el arranque del módulo, pero también un controller que devuelve su resultado
   (`tipo-cambio.controller.ts:77`). Tragarse el fallo adentro convertiría el 500
   legítimo de ese endpoint en un 200 que miente.

**Los doce sitios** pasan por el helper, incluidos los nueve que ya estaban
protegidos: la consistencia es la que hace verificable la regla, y un try/catch
interno puede desaparecer en una edición futura sin que nadie relacione las dos
cosas.

**`scripts/verificar-skills.mjs`**: regla nueva. `npm run build` rechaza desde hoy
cualquier `void algo.metodo(` en `src/` que no vaya por `enSegundoPlano` ni tenga
un `.catch()` propio en la misma sentencia. Se comprobó que muerde de verdad
—no que sea decorativa— devolviendo a mano el sitio de Actividades a su forma
anterior: `check:skills` falló señalando archivo y línea, y volvió a pasar al
restaurarlo. Es el mismo mecanismo con el que se cerró la puerta a
`from '@prisma/client'`.

**Dos garantías escritas que no se cumplían.** La cabecera de
`DespachadorSalienteService` decía que "ninguno lanza", y el comentario de
`registrarResultadoEnvio` justificaba el `updateMany` diciendo que corre "en un
`void` sin `.catch()`". Lo primero era falso —el `updateMany` rechaza si la base
no responde—; lo segundo dejó de ser cierto con esta entrega. Ambos corregidos.
El `updateMany` se queda: sigue siendo lo correcto para el caso normal de la
conversación borrada mientras Meta contestaba, que es distinto de tolerar un
fallo de base.

## Cambios deliberados de comportamiento

Un fallo en cualquiera de esos doce caminos pasa de tumbar el proceso a quedar
registrado en el journal con la línea `Falló en segundo plano: <contexto>` y su
causa. El trabajo se pierde igual: **no se reintenta nada**. Un mensaje que no
salió queda en FALLIDO y una agente lo reintenta a mano.

Eso es peor que un reintento y mejor que un bucle de reinicios, y es
explícitamente un paso intermedio: la entrega 2 de F06 es la que añade estado y
reintento. Mientras tanto, un fallo silencioso pero visible en el log es
preferible a un servicio que systemd muestra `active` mientras se reinicia cada
cinco minutos.

## Límites

- No se reprodujo el escape de los webhooks ni de los tres sitios de ingesta:
  se envuelven por consistencia y para satisfacer la regla nueva, no porque se
  demostrara el fallo.
- La regla de `check:skills` es textual, por línea, con una ventana de ocho
  líneas para encontrar un `.catch()`. Un `void` construido de otra forma
  —guardando la promesa en una variable y descartándola después— no lo detecta.
  Cubre la forma en que se escribe hoy en este repo, no todas las posibles.
- No se midió el coste del helper. Es una función `async` por disparo; en los
  caminos de fondo de este backend eso no se acerca a nada medible, pero no se
  midió.
- No se tocó la ventana de 24/72 h, ni el orden de los `statuses`, ni el tope del
  barrido, ni la concurrencia de notificaciones.
- Los dos `.catch()` del gateway se dejan como estaban: hacen algo más
  específico que registrar y pasarlos al helper les quitaría esa lógica.

## Verificación

- 472 pruebas unitarias en 30 suites (eran 465 en 29; +7 de este archivo).
- `npm run build` completo: `check:skills` con la regla nueva, compilación y
  `check:build` confirmando `dist/main.js`.
- Suite de integración contra PostgreSQL 16 descartable en loopback, base
  `crm_test` — resultado anotado en el commit.
- La regla nueva, probada en ambos sentidos: falla con la regresión metida a
  propósito, pasa al restaurar.

## Rollback

Solo código y un script; **no hay migración ni cambio de datos**. Revertir el
commit devuelve los doce sitios a su forma anterior y con ellos el defecto: un
rechazo fuera de la petición vuelve a poder tumbar el proceso. La regla de
`check:skills` desaparece con el mismo revert, así que no queda bloqueando nada.

No se desplegó ni se consultó producción en esta entrega. Sigue pendiente de
producción la migración de F05 (`20260907180000_sesion_revocable`); ver
`auditoria-estado.md`.
