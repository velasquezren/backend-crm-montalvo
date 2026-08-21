import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';

import './request.types';

/**
 * Una línea por petición HTTP exitosa, con el mismo `requestId` que
 * `asignarRequestId` puso en la cabecera de respuesta. Los errores NO se
 * registran aquí — los registra `AllExceptionsFilter`, que corre después y ya
 * conoce el status real que se va a responder. Registrar ambos aquí duplicaría
 * la línea con un status engañoso (el que había antes de que el filtro actúe).
 *
 * No registra cuerpo ni cabeceras: son datos de pacientes.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const inicio = Date.now();

    return next.handle().pipe(
      tap(() => {
        const ms = Date.now() - inicio;
        this.logger.log(`${req.requestId} ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`);
      }),
    );
  }
}
