import 'express';

/**
 * Amplía el `Request` de Express con el id que asigna `asignarRequestId`.
 * Un solo lugar para el tipo — `LoggingInterceptor` y `AllExceptionsFilter`
 * lo importan en vez de castear `req` a `any` cada vez que lo necesitan.
 */
declare module 'express' {
  interface Request {
    /**
     * Opcional a propósito: lo asigna un middleware, así que el tipo no puede
     * prometer que exista. Declararlo obligatorio hacía que un camino que no
     * pasara por `asignarRequestId` imprimiera `undefined` en el log sin que
     * el compilador dijera nada. Para leerlo, `idPeticion(req)`.
     */
    requestId?: string;
  }
}
