import type { Request } from 'express';

/**
 * La ruta de una petición **sin el query string**, para logs.
 *
 * `req.originalUrl` incluye los parámetros, y por ahí viajan datos de
 * pacientes: `GET /clientes?busqueda=Maria+Perez` (ver `QueryClienteDto`),
 * búsquedas de mensajes, filtros por teléfono. Escribirlos en el log del VPS
 * es guardar historial clínico en texto plano en un archivo que nadie rota ni
 * audita — justo lo que `LoggingInterceptor` ya evitaba con el cuerpo y las
 * cabeceras.
 *
 * Se corta sobre `originalUrl` y no se usa `req.path` porque `path` es
 * relativo al punto de montaje: hoy da igual (no hay `setGlobalPrefix`), pero
 * el día que lo haya, `path` empezaría a mentir sobre la ruta real.
 */
export function rutaSinQuery(req: Request): string {
  return req.originalUrl.split('?')[0];
}

/** El id de correlación, o un marcador si la petición no pasó por `asignarRequestId`. */
export function idPeticion(req: Request): string {
  return req.requestId ?? 'sin-id';
}
