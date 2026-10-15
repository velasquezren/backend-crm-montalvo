import { CanActivate, ExecutionContext, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';

@Injectable()
export class HorarioFilemakerGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(contexto: ExecutionContext): boolean {
    const secreto = this.config.get<string>('FILEMAKER_HORARIOS_TOKEN') ?? '';
    if (this.config.get<string>('FILEMAKER_HORARIOS_ACTIVO') !== 'on' || secreto.length < 32) {
      throw new ServiceUnavailableException('La integración de horarios con FileMaker no está habilitada.');
    }
    const cabecera = contexto.switchToHttp().getRequest<{ headers: { authorization?: string } }>().headers.authorization;
    const recibido = typeof cabecera === 'string' ? /^Bearer ([^\s]{32,256})$/i.exec(cabecera)?.[1] : undefined;
    const hash = (s: string) => createHash('sha256').update(s).digest();
    if (!recibido || !timingSafeEqual(hash(recibido), hash(secreto))) throw new UnauthorizedException('Credencial de integración inválida.');
    return true;
  }
}
