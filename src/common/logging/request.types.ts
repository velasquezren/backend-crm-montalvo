import 'express';

/**
 * Amplía el `Request` de Express con el id que asigna `asignarRequestId`.
 * Un solo lugar para el tipo — `LoggingInterceptor` y `AllExceptionsFilter`
 * lo importan en vez de castear `req` a `any` cada vez que lo necesitan.
 */
declare module 'express' {
  interface Request {
    requestId: string;
  }
}
