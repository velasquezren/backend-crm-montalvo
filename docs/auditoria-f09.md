# F09 — Dos Service Workers peleándose por el mismo scope

9 de septiembre de 2026. Cierra F09 del [informe maestro](auditoria-arquitectonica-2026-09-05.md).
Toca los dos repos. Sin cambios en reglas financieras, autorización, sesión ni
esquema; **no hay migración**.

## Qué se encontró

El scope `/` de un origen admite **una** registración de Service Worker.
Registrar un segundo script ahí no convive con el primero: lo sustituye.

Había dos, y los dos apuntaban a `/`:

- `provideServiceWorker('ngsw-worker.js', { registrationStrategy: 'registerImmediately' })`
  en `app.config.ts` — se registra en **cada carga de la app**.
- `navigator.serviceWorker.register('/sw.js')` en `notificacion-nativa.service.ts`,
  llamado desde `registrarServiceWorkerYVapid()` — que dispara
  `conversaciones.page.ts` **cada vez que una agente abre el inbox**.

O sea que no era una carrera ocasional de arranque: se turnaban a lo largo del
día, y cada turno rompía la mitad del otro.

| Activo | Push | `SwUpdate` (avisos de versión nueva) |
| --- | --- | --- |
| el propio | funcionaba | **muerto** |
| `ngsw-worker.js` | **silencio total** | funcionaba |

El silencio no es una hipótesis. Es lo que hace el `ngsw-worker.js` que se
despacha en `node_modules/@angular/service-worker/`, leído directamente:

```js
async handlePush(data) {
  await this.broadcast({ type: 'PUSH', data });
  if (!data.notification || !data.notification.title) {
    return;                     // ← el aviso se pierde, sin log y sin error
  }
  ...
}
```

El backend mandaba `{ titulo, mensaje, url, count }`. Sin la clave `notification`,
`return`. Y `SwUpdate` **sí** está en uso (`pwa-update.service.ts`), así que la
otra mitad también es carga real.

Ninguno de los dos fallos produce un error visible. Del lado de la agente se ve
como "a veces no me llegan las notificaciones" — que es exactamente lo que el
`CLAUDE.md` del backend anticipa como el peor desenlace posible: la notificación
que importa, perdida.

## Reproducción

No se pudo reproducir con una prueba: haría falta un navegador de verdad con dos
Service Workers compitiendo, y en este proyecto **no se usa el navegador**. Lo
que sí se hizo es leer el worker que se despacha y fijar la forma del payload
contra su comprobación real (`src/common/push/cuerpo-push.spec.ts`, que cita el
código de ngsw en su cabecera).

Es una diferencia honesta respecto a F06 y F07, donde el fallo se reprodujo
primero. Aquí la evidencia es el código de un tercero, no una prueba en rojo.

## Qué cambió

**Un solo Service Worker: el de Angular.** Se borra el propio y la suscripción
Web Push pasa por `SwPush`, que se monta sobre la registración que ya existe en
vez de crear otra. Con eso desaparecen también el registro manual y el auxiliar
de base64 para las llaves VAPID, que `SwPush` ya hace.

**El backend manda la forma que ngsw entiende** (`common/push/cuerpo-push.ts`,
nuevo). El sobre `notification` con `title`, `body`, `icon`, `badge`, `tag`,
`renotify`, y `data.onActionClick.default` con `navigateLastFocusedOrOpen` — que
es la única forma de controlar el clic cuando la app está cerrada.

**Los campos planos se siguen mandando**, a propósito y por ahora: durante el
despliegue habrá teléfonos con el Service Worker anterior todavía activo, que lee
`titulo`/`mensaje` de la raíz del payload. Mandar las dos formas hace que la
transición no deje a nadie sin avisos. Se pueden quitar cuando no quede ningún
cliente con el worker viejo; hasta entonces, no.

**`check:skills` del frontend gana la regla.** Rechaza cualquier
`serviceWorker.register(` en el código de la app, la reaparición de un worker
propio en `public/`, y que `app.config.ts` deje de montar `ngsw-worker.js`.
Ignora comentarios: sin eso, la propia explicación de la cicatriz —que cita la
línea prohibida— disparaba la regla. Pasó al escribirla.

## Lo que se pierde

**`setAppBadge` con la app cerrada.** El número sobre el icono de la PWA lo
pintaba el worker propio dentro del evento `push`, y solo un worker propio puede
hacerlo. Con la app abierta se sigue actualizando desde
`NotificacionNativaService.actualizarBadge()`, que no cambió.

Decidido explícitamente con el usuario el 9 de septiembre, sobre dos opciones. La
alternativa era un worker propio que hiciera `importScripts('ngsw-worker.js')` y
añadiera encima el push, el clic y el badge: conserva todo, pero es un patrón que
Angular no documenta ni garantiza y deja dos manejadores de `push` corriendo a la
vez. Se prefirió la vía soportada.

## Límites conocidos

- **No se probó en un navegador**, ni el fallo ni el arreglo. La evidencia del
  fallo es el código de `ngsw-worker.js`; la del arreglo, que el payload cumple
  lo que ese código exige. **Al desplegar hay que comprobar a mano que llega una
  notificación con la app cerrada.**
- **La transición depende de que ngsw reclame el scope.** Un teléfono con el
  worker anterior activo lo conserva hasta la siguiente carga de la app; hasta
  entonces sigue leyendo los campos planos, que por eso se mandan.
- **El backend puede desplegarse solo y antes**: el payload nuevo es aditivo y el
  worker anterior lo sigue entendiendo. El frontend no puede ir antes que el
  backend sin dejar un hueco — ngsw activo con payload viejo es justo el silencio
  que se está arreglando.

## Verificación

- Backend: **505 unitarias en 33 suites** (eran 499 en 32; +6 de `cuerpo-push`),
  `npm run build` y `test:build`.
- Frontend: typecheck, **80 pruebas en 9 suites**, y `npm run build` completo.
- **La regla nueva muerde**, comprobado en sus dos formas: reintroduciendo un
  `serviceWorker.register(` en el servicio de notificaciones, y volviendo a
  poner un worker en `public/`. Falla en los dos casos y pasa al deshacerlos.

## Rollback

Solo código; no hay migración ni cambio de datos. Revertir los dos commits
devuelve los dos Service Workers y con ellos el defecto. Si se revierte **solo el
frontend**, el backend sigue mandando las dos formas y no se rompe nada. Si se
revierte **solo el backend**, los teléfonos que ya tengan ngsw activo se quedan
sin notificaciones: ese orden no.
