import { ExecutionContext, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AvisosFilemakerGuard } from './avisos-filemaker.guard';

const SECRETO = 'f'.repeat(64);

function contexto(authorization?: string): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => ({ headers: { authorization } }) }) } as unknown as ExecutionContext;
}

function guard(entorno: Record<string, string>): AvisosFilemakerGuard {
  return new AvisosFilemakerGuard(new ConfigService(entorno));
}

describe('AvisosFilemakerGuard', () => {
  it('apagada por omisión: ni con la credencial correcta deja pasar', () => {
    expect(() => guard({ FILEMAKER_AVISOS_TOKEN: SECRETO }).canActivate(contexto(`Bearer ${SECRETO}`))).toThrow(ServiceUnavailableException);
  });

  it('encendida con un secreto corto tampoco: se trata como sin configurar', () => {
    const corto = 'x'.repeat(31);
    expect(() => guard({ FILEMAKER_AVISOS_ACTIVO: 'on', FILEMAKER_AVISOS_TOKEN: corto }).canActivate(contexto(`Bearer ${corto}`))).toThrow(
      ServiceUnavailableException,
    );
  });

  it('encendida: acepta solo el secreto exacto como Bearer', () => {
    const g = guard({ FILEMAKER_AVISOS_ACTIVO: 'on', FILEMAKER_AVISOS_TOKEN: SECRETO });
    expect(g.canActivate(contexto(`Bearer ${SECRETO}`))).toBe(true);
    for (const cabecera of [undefined, SECRETO, `Bearer ${'g'.repeat(64)}`, `Bearer ${SECRETO}x`, `Basic ${SECRETO}`]) {
      expect(() => g.canActivate(contexto(cabecera))).toThrow(UnauthorizedException);
    }
  });
});
