import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  RawBodyRequest,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

/**
 * Verifica la firma `X-Hub-Signature-256` con la que Meta firma cada POST del
 * webhook (HMAC-SHA256 del cuerpo CRUDO usando el App Secret de la app de Meta).
 *
 * Sin esto el endpoint era la puerta más abierta del CRM: `@Public()` (sin JWT),
 * `@SkipThrottle()` (sin rate-limit) y escribiendo en base. Cualquiera que
 * conociera la URL —que es pública por necesidad, Meta tiene que alcanzarla—
 * podía dar de alta pacientes y leads sin límite, inyectar mensajes falsos en el
 * hilo de cualquier paciente, y marcar mensajes como entregados/leídos.
 * `META_VERIFY_TOKEN` no cubre esto: solo protege el GET de alta de la
 * suscripción, no los POST posteriores.
 *
 * **Falla cerrado**: si `META_APP_SECRET` no está configurado se rechaza todo.
 * Es deliberado — un modo "sin secreto, dejar pasar" deja el agujero abierto
 * para siempre. El precio es que la variable es obligatoria para recibir
 * mensajes; el error se registra en cada rechazo para que el diagnóstico sea
 * inmediato.
 *
 * Requiere `rawBody: true` en `NestFactory.create` (ver main.ts): la firma se
 * calcula sobre los bytes exactos que mandó Meta, no sobre el JSON reserializado
 * —cualquier diferencia de espacios o de orden de claves cambiaría el HMAC.
 */
@Injectable()
export class WhatsappSignatureGuard implements CanActivate {
  private readonly logger = new Logger(WhatsappSignatureGuard.name);

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const secreto = this.config.get<string>('META_APP_SECRET');
    if (!secreto) {
      this.logger.error(
        'META_APP_SECRET no está configurado: se rechaza el webhook de WhatsApp. ' +
          'Añádelo al .env (Meta → App → Configuración → Básica → Clave secreta) o no entrará ningún mensaje.',
      );
      throw new ForbiddenException('Webhook no configurado');
    }

    const request = context.switchToHttp().getRequest<RawBodyRequest<Request>>();

    /* El cuerpo crudo solo existe si `rawBody: true` está activo. Si falta, es
       un error de configuración nuestro, no un intento de fraude: se distingue
       en el log para no mandar a nadie a buscar un atacante inexistente. */
    const cuerpo = request.rawBody;
    if (!cuerpo?.length) {
      this.logger.error(
        'Webhook sin cuerpo crudo: ¿falta `rawBody: true` en NestFactory.create? No se puede verificar la firma.',
      );
      throw new ForbiddenException('Firma no verificable');
    }

    const cabecera = request.headers['x-hub-signature-256'];
    const recibida = Array.isArray(cabecera) ? cabecera[0] : cabecera;
    if (!recibida?.startsWith('sha256=')) {
      this.logger.warn('Webhook de WhatsApp rechazado: falta la cabecera X-Hub-Signature-256');
      throw new ForbiddenException('Firma ausente');
    }

    const esperada = createHmac('sha256', secreto).update(cuerpo).digest();
    /* `Buffer.from(hex, 'hex')` trunca en silencio ante caracteres inválidos,
       así que la comparación de longitud también cubre una firma malformada —
       y hace falta igual porque `timingSafeEqual` lanza si difieren. */
    const recibidaBuf = Buffer.from(recibida.slice('sha256='.length), 'hex');
    if (
      recibidaBuf.length !== esperada.length ||
      !timingSafeEqual(recibidaBuf, esperada)
    ) {
      this.logger.warn('Webhook de WhatsApp rechazado: firma X-Hub-Signature-256 inválida');
      throw new ForbiddenException('Firma inválida');
    }

    return true;
  }
}
