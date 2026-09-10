/** Lo que el CRM quiere avisar; la forma que viaja la decide `cuerpoPush`. */
export interface PushNotificationPayload {
  titulo: string;
  mensaje: string;
  url?: string;
  tag?: string;
  count?: number;
}

const URL_POR_DEFECTO = '/conversaciones';
const ICONO = '/web-app-manifest-192x192.png';
const INSIGNIA = '/favicon-96x96.png';

/**
 * Arma el cuerpo del push con la forma que el Service Worker de Angular exige.
 *
 * **Por qué existe este archivo.** El CRM registraba dos Service Workers en el
 * mismo scope `/` —el de Angular y uno propio— y un scope solo admite una
 * registración, así que se turnaban. Cuando el activo era el de Angular, el
 * aviso no se mostraba: `ngsw-worker.js` hace `return` si el payload no trae
 * `notification.title`, sin log y sin error. El backend mandaba los campos
 * sueltos (`titulo`, `mensaje`), así que la mitad de los pushes se perdía en
 * silencio. Ver `cuerpo-push.spec.ts`, que cita el código de ngsw.
 *
 * Dos detalles que no son de estilo:
 *
 * 1. **Solo se usan claves de la lista blanca de ngsw**
 *    (`NOTIFICATION_OPTION_NAMES`). Lo que esté fuera se descarta sin avisar,
 *    que es como se pierde un icono o una vibración sin que nadie lo note.
 * 2. **`data.onActionClick` es la única forma de controlar el clic con la app
 *    cerrada.** Sin eso, tocar la notificación abre la raíz y la agente tiene
 *    que buscar la conversación a mano.
 *
 * Los campos planos (`titulo`, `mensaje`, `url`, `count`) se mandan **además**
 * del sobre, a propósito: durante el despliegue habrá teléfonos con el
 * `sw.js` anterior todavía activo, que lee esos campos. Se pueden quitar cuando
 * no quede ninguno — no antes, o esa transición deja a alguien sin avisos.
 */
export function cuerpoPush(payload: PushNotificationPayload): string {
  const url = payload.url || URL_POR_DEFECTO;

  return JSON.stringify({
    /* Lo que lee el Service Worker de Angular. */
    notification: {
      title: payload.titulo,
      body: payload.mensaje,
      icon: ICONO,
      badge: INSIGNIA,
      tag: payload.tag || 'crm-montalvo-push',
      renotify: true,
      data: {
        url,
        count: payload.count ?? 1,
        onActionClick: {
          default: { operation: 'navigateLastFocusedOrOpen', url },
        },
      },
    },

    /* Compatibilidad con el `sw.js` anterior mientras queden clientes con él. */
    titulo: payload.titulo,
    mensaje: payload.mensaje,
    url,
    tag: payload.tag,
    count: payload.count,
  });
}
