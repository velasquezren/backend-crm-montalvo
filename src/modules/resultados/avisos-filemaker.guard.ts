import { CanActivate, ExecutionContext, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Credencial del guion de ecografía de FileMaker para pedir el aviso por
 * WhatsApp. Es PROPIA: ni la de horarios ni la del portal de resultados. Si
 * se filtra una, se rota solo esa.
 *
 * Apagada por omisión (`FILEMAKER_AVISOS_ACTIVO`): hasta encenderla, la
 * entrega sigue siendo solo el botón de la pantalla Resultados del CRM.
 */
@Injectable()
export class AvisosFilemakerGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(contexto: ExecutionContext): boolean {
    const secreto = this.config.get<string>('FILEMAKER_AVISOS_TOKEN') ?? '';
    if (this.config.get<string>('FILEMAKER_AVISOS_ACTIVO') !== 'on' || secreto.length < 32) {
      throw new ServiceUnavailableException('El envío de avisos desde FileMaker no está habilitado.');
    }
    const cabecera = contexto.switchToHttp().getRequest<{ headers: { authorization?: string } }>().headers.authorization;
    const recibido = typeof cabecera === 'string' ? /^Bearer ([^\s]{32,256})$/i.exec(cabecera)?.[1] : undefined;
    /* Se comparan los hashes y no las cadenas: `timingSafeEqual` exige el
       mismo largo y compararlo antes revelaría el largo del secreto. */
    const hash = (s: string) => createHash('sha256').update(s).digest();
    if (!recibido || !timingSafeEqual(hash(recibido), hash(secreto))) throw new UnauthorizedException('Credencial de integración inválida.');
    return true;
  }
}
