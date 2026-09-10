import { cuerpoPush } from './cuerpo-push';

/**
 * F09 — que el aviso llegue al teléfono en vez de morir en silencio.
 *
 * El CRM registraba DOS Service Workers en el mismo scope `/`: el de Angular
 * (`ngsw-worker.js`, vía `provideServiceWorker`) y uno propio (`public/sw.js`,
 * registrado a mano cada vez que una agente abría el inbox). Un scope solo
 * admite una registración, así que se sustituían el uno al otro en cada carga.
 *
 * Y cuando el activo era el de Angular, el push **no mostraba nada**. Esto es
 * literalmente lo que hace `ngsw-worker.js` (verificado sobre el archivo que se
 * despacha, no de memoria):
 *
 * ```js
 * async handlePush(data) {
 *   await this.broadcast({ type: 'PUSH', data });
 *   if (!data.notification || !data.notification.title) {
 *     return;                       // ← el aviso se pierde, sin un solo error
 *   }
 *   ...
 * }
 * ```
 *
 * El backend mandaba `{ titulo, mensaje, url }`. Sin la clave `notification`,
 * `return`. Es exactamente el desenlace del que avisa el CLAUDE.md de este repo:
 * la notificación que importa, perdida, y nadie se entera.
 *
 * Estas pruebas fijan la forma del cuerpo contra lo que ngsw exige de verdad.
 * Si alguien "simplifica" el payload quitando el sobre, fallan aquí y no en el
 * teléfono de una agente un domingo.
 */

const PAYLOAD = {
  titulo: 'Nuevo mensaje',
  mensaje: 'Ana García: hola, quería consultar',
  url: '/conversaciones/abc',
  tag: 'conv-abc',
  count: 3,
};

/** Lo que `ngsw-worker.js` comprueba antes de mostrar nada. */
function ngswMostraria(cuerpo: string): boolean {
  const data = JSON.parse(cuerpo) as { notification?: { title?: string } };
  return Boolean(data.notification && data.notification.title);
}

describe('cuerpoPush', () => {
  it('trae el sobre `notification` con título: sin eso ngsw no muestra nada', () => {
    expect(ngswMostraria(cuerpoPush(PAYLOAD))).toBe(true);
  });

  it('el título y el cuerpo son los que escribió el backend', () => {
    const { notification } = JSON.parse(cuerpoPush(PAYLOAD));

    expect(notification.title).toBe('Nuevo mensaje');
    expect(notification.body).toBe('Ana García: hola, quería consultar');
    expect(notification.tag).toBe('conv-abc');
  });

  /**
   * ngsw filtra las opciones contra una lista blanca
   * (`NOTIFICATION_OPTION_NAMES`) y descarta el resto. Una clave fuera de esa
   * lista no da error: simplemente no llega, que es la forma silenciosa de
   * perder el icono o la vibración.
   */
  it('no usa ninguna opción que ngsw vaya a descartar', () => {
    const PERMITIDAS = [
      'actions', 'badge', 'body', 'data', 'dir', 'icon', 'image', 'lang',
      'renotify', 'requireInteraction', 'silent', 'tag', 'timestamp', 'title', 'vibrate',
    ];
    const { notification } = JSON.parse(cuerpoPush(PAYLOAD));

    expect(Object.keys(notification).filter(k => !PERMITIDAS.includes(k))).toEqual([]);
  });

  /**
   * Con la app cerrada, quien maneja el clic es ngsw, y solo sabe hacerlo por
   * `data.onActionClick`. Sin esto la notificación se abre en la raíz y la
   * agente tiene que buscar la conversación a mano.
   */
  it('el clic enfoca la pestaña abierta o abre la conversación', () => {
    const { notification } = JSON.parse(cuerpoPush(PAYLOAD));

    expect(notification.data.onActionClick.default).toEqual({
      operation: 'navigateLastFocusedOrOpen',
      url: '/conversaciones/abc',
    });
  });

  it('sin url, el clic lleva al inbox', () => {
    const { notification } = JSON.parse(cuerpoPush({ titulo: 'x', mensaje: 'y' }));

    expect(notification.data.onActionClick.default.url).toBe('/conversaciones');
  });

  /**
   * Durante el despliegue habrá teléfonos con el `sw.js` viejo todavía activo,
   * que lee `titulo`/`mensaje` de la raíz del payload. Se mandan las dos formas
   * a la vez para que la transición no deje a nadie sin avisos; se pueden
   * quitar cuando ya no quede ningún cliente con el SW anterior.
   */
  it('conserva los campos planos del SW anterior mientras dure la transición', () => {
    const cuerpo = JSON.parse(cuerpoPush(PAYLOAD));

    expect(cuerpo.titulo).toBe('Nuevo mensaje');
    expect(cuerpo.mensaje).toBe('Ana García: hola, quería consultar');
    expect(cuerpo.url).toBe('/conversaciones/abc');
    expect(cuerpo.count).toBe(3);
  });
});
