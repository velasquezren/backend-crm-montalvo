import { Logger } from '@nestjs/common';
import type { Request } from 'express';

/**
 * INSTRUMENTACIÓN TEMPORAL DE R3 — se elimina en cuanto haya medición.
 *
 * Existe para responder una sola pregunta: dónde viven los ~60 ms que separan
 * lo que se pudo medir de `GET /conversaciones` desde fuera (10-15 ms) de lo
 * que reporta el logger en producción (79 ms de mediana).
 *
 * Apagada por defecto. Solo hace algo con `R3_PROFILE_INBOX=1` en el entorno,
 * y entonces **solo** para `GET /conversaciones`: ninguna otra ruta se toca.
 *
 * No registra datos de negocio. Ni nombres, ni teléfonos, ni ids clínicos, ni
 * el contenido de los filtros — solo el nombre de la fase, su duración en
 * milisegundos y el id técnico de la petición, que ya existe y es efímero.
 */
const ACTIVO = process.env['R3_PROFILE_INBOX'] === '1';

const logger = new Logger('R3_INBOX');

/** Marcas de una petición: nombre de fase e instante monotónico. */
type Marcas = Array<[string, bigint]>;

interface ConMarcas {
  __r3?: Marcas;
}

/** `true` solo para el listado del inbox; el resto del tráfico se ignora. */
function esElInbox(req: Request): boolean {
  return req.method === 'GET' && (req.path === '/conversaciones' || req.originalUrl.split('?')[0] === '/conversaciones');
}

/**
 * Anota una fase. Monotónico (`process.hrtime.bigint()`), nunca `Date.now()`:
 * el reloj de pared puede saltar y aquí se miden diferencias de milisegundos.
 */
export function marcaR3(req: Request | undefined, fase: string): void {
  if (!ACTIVO || !req || !esElInbox(req)) return;
  const portador = req as Request & ConMarcas;
  (portador.__r3 ??= []).push([fase, process.hrtime.bigint()]);
}

/**
 * Vuelca una línea por petición con el reparto de tiempos.
 *
 * Formato: `R3_INBOX requestId=<id> total=<ms> fase=<n>:<ms> …`, pensado para
 * agregarse con `grep`/`awk` sin tocar nada más.
 */
export function volcarR3(req: Request | undefined, requestId: string): void {
  if (!ACTIVO || !req || !esElInbox(req)) return;
  const marcas = (req as Request & ConMarcas).__r3;
  if (!marcas || marcas.length < 2) return;

  const ms = (a: bigint, b: bigint): string => (Number(b - a) / 1e6).toFixed(2);
  const total = ms(marcas[0][1], marcas[marcas.length - 1][1]);
  const tramos = marcas
    .slice(1)
    .map(([fase, t], i) => `${fase}=${ms(marcas[i][1], t)}`)
    .join(' ');

  logger.log(`requestId=${requestId} total=${total} ${tramos}`);
}
