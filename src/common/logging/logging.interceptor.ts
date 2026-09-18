import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';

import './request.types';
import { idPeticion, rutaSinQuery } from './ruta-peticion';
/* R3 TEMPORAL — perfilado del inbox; ver perfil-r3.ts. */
import { marcaR3, volcarR3 } from './perfil-r3';

/**
 * Una línea por petición HTTP exitosa, con el mismo `requestId` que
 * `asignarRequestId` puso en la cabecera de respuesta. Los errores NO se
 * registran aquí — los registra `AllExceptionsFilter`, que corre después y ya
 * conoce el status real que se va a responder. Registrar ambos aquí duplicaría
 * la línea con un status engañoso (el que había antes de que el filtro actúe).
 *
 * No registra cuerpo, cabeceras ni query string: son datos de pacientes
 * (ver `rutaSinQuery`).
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
    /* R3 TEMPORAL */
    marcaR3(req, 'guards_ok');
    res.on('finish', () => {
      marcaR3(req, 'respuesta_escrita');
      volcarR3(req, idPeticion(req));
    });

    return next.handle().pipe(
      tap(() => {
        marcaR3(req, 'handler_resuelto'); /* R3 TEMPORAL */
        const ms = Date.now() - inicio;
        this.logger.log(`${idPeticion(req)} ${req.method} ${rutaSinQuery(req)} ${res.statusCode} ${ms}ms`);
      }),
    );
  }
}
