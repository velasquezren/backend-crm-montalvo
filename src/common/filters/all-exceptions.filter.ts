import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';

import '../logging/request.types';
import { idPeticion, rutaSinQuery } from '../logging/ruta-peticion';

/**
 * Red de seguridad final de errores HTTP.
 *
 * Sin esto, una excepción que NO es un `HttpException` (un `TypeError`, un
 * error de Prisma que se escapó de su try/catch) caía al manejador default de
 * Nest: un 500 sin forma consistente y sin nada que lo ate al log del
 * servidor. Con "no hay staging, un error lo ve una paciente" (CLAUDE.md), la
 * velocidad para encontrar QUÉ pasó importa tanto como que no pase.
 *
 * A los `HttpException` normales (400 de validación, 401, 404 de negocio…) NO
 * se les toca la forma: se respeta exactamente `getResponse()`, que es lo que
 * el frontend ya consume (`{ statusCode, message, error }`). Solo se le suma
 * `requestId`, aditivo y sin romper nada existente.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    /* Los guards/gateways de WebSocket no pasan por aquí en la práctica (el
       gateway de conversaciones no tiene @SubscribeMessage), pero si alguna
       vez lo hace, este filtro solo sabe responder HTTP — no debe reventar
       intentando tratar el contexto como Express. */
    if (host.getType() !== 'http') {
      this.logger.error(
        'Excepción fuera de un contexto HTTP (WebSocket/RPC)',
        exception instanceof Error ? exception.stack : String(exception),
      );
      return;
    }

    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    /* Mismo recorte de query string que el interceptor: un error no es
       excusa para escribir el nombre de una paciente en el log. */
    const requestId = idPeticion(req);
    const ruta = rutaSinQuery(req);

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const cuerpo = exception.getResponse();
      const forma = typeof cuerpo === 'string' ? { message: cuerpo } : cuerpo;

      /* Un HttpException con status 5xx explícito es tan inesperado como uno
         sin capturar: también queda con stack en el log. */
      if (status >= 500) {
        this.logger.error(`${requestId} ${req.method} ${ruta} ${status}`, exception.stack);
      }

      res.status(status).json({ ...forma, requestId });
      return;
    }

    /* Cualquier otra cosa: nunca se expone el mensaje real al cliente —puede
       traer detalle interno (ruta de archivo, SQL, stack)— pero sí queda
       completo en el log del servidor, atado al mismo requestId que ve el
       cliente en la respuesta. */
    const error = exception instanceof Error ? exception : new Error(String(exception));
    this.logger.error(`${requestId} ${req.method} ${ruta} 500 — sin capturar`, error.stack);

    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Error interno del servidor',
      requestId,
    });
  }
}
