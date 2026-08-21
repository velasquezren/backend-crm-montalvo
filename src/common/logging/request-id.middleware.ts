import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

import './request.types';

const CABECERA = 'X-Request-Id';

/**
 * Asigna un id único a cada petición entrante y lo devuelve en la cabecera de
 * respuesta. Sin esto, rastrear un incidente en producción —no hay entorno de
 * staging, CLAUDE.md dixit— significa cruzar el log del servidor con lo que
 * vio la agente por hora aproximada.
 *
 * `LoggingInterceptor` registra este id en cada petición exitosa y
 * `AllExceptionsFilter` lo incluye en cada error, así que una sola búsqueda
 * de texto en el log reconstruye qué pasó con UNA petición concreta.
 *
 * Si Apache (el proxy inverso, ver `main.ts`) ya mandó uno, se respeta: deja
 * correlacionar con su propio log de acceso en vez de generar uno nuevo a
 * mitad de la cadena.
 */
export function asignarRequestId(req: Request, res: Response, next: NextFunction): void {
  const entrante = req.get(CABECERA);
  const id = entrante && entrante.length <= 100 ? entrante : randomUUID();
  req.requestId = id;
  res.setHeader(CABECERA, id);
  next();
}
