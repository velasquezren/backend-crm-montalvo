import { createHash } from 'node:crypto';

/** Lo que el CRM quiere avisar; la forma que viaja la decide `cuerpoPush`. */
export interface PushNotificationPayload {
  titulo: string;
  mensaje: string;
  url?: string;
  tag?: string;
  count?: number;
  /** Cuánto vale el aviso si llega tarde. Ver `opcionesEntrega`. */
  entrega?: {
    /** Segundos que el servicio de push lo guarda si el teléfono no está. */
    vigenciaSegundos?: number;
    /** Despierta al teléfono aunque esté en ahorro de batería. */
    urgente?: boolean;
  };
}

/**
 * Una hora: si en ese tiempo no llegó al teléfono, la bandeja ya lo muestra
 * en «Sin responder», y llegar después solo suma ruido. Ver `opcionesEntrega`.
 */
export const VIGENCIA_POR_DEFECTO_S = 60 * 60;

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

/**
 * Las cabeceras de entrega del Web Push (RFC 8030 §5): cuánto se guarda el
 * aviso si el teléfono no está, con qué prioridad, y cuál reemplaza a cuál.
 *
 * **Por qué no se dejan los valores de `web-push`.** Sin opciones, la librería
 * manda `TTL` de **cuatro semanas** y ningún `Topic`. Un teléfono apagado el
 * fin de semana recibía el lunes la ráfaga entera, un aviso por cada mensaje
 * viejo que la bandeja ya mostraba: justo el ruido que acaba con las
 * notificaciones desactivadas.
 *
 * - `TTL`: por defecto una hora (`VIGENCIA_POR_DEFECTO_S`). Quien necesite más
 *   —un aviso de plataforma que solo un admin resuelve— lo pide.
 * - `Topic`: sale del `tag`. Mientras un aviso espera en el servicio de push,
 *   uno nuevo con el mismo topic lo **reemplaza** en vez de ponerse en cola: al
 *   reconectar llega solo el último de cada chat. Es lo mismo que ya hace el
 *   `tag` en pantalla, pero antes de gastar la batería de la entrega. La RFC
 *   pide como mucho 32 caracteres del alfabeto base64url, y `chat-<uuid>` tiene
 *   41; por eso es un hash del tag y no el tag.
 * - `Urgency`: `high` solo para lo que tiene a alguien esperando. En Android es
 *   lo que decide si el aviso atraviesa el modo de ahorro de batería o espera
 *   a la siguiente ventana de mantenimiento. Todo lo demás, `normal`.
 */
export function opcionesEntrega(payload: PushNotificationPayload): {
  TTL: number;
  urgency: 'normal' | 'high';
  topic?: string;
} {
  return {
    TTL: payload.entrega?.vigenciaSegundos ?? VIGENCIA_POR_DEFECTO_S,
    urgency: payload.entrega?.urgente ? 'high' : 'normal',
    ...(payload.tag ? { topic: createHash('sha256').update(payload.tag).digest('base64url').slice(0, 32) } : {}),
  };
}
