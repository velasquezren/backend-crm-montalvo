import { createHmac } from 'node:crypto';

import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { MetaSignatureGuard } from './meta-signature.guard';

/**
 * El webhook de WhatsApp es `@Public()` y `@SkipThrottle()`, y escribe en base:
 * da de alta pacientes, crea leads y mete mensajes en el hilo de cualquier
 * paciente. Lo único que separa eso de internet es esta firma. Si estas pruebas
 * se ponen en verde de más (un `return true` de más, un secreto vacío que pasa),
 * el CRM queda abierto a cualquiera que conozca la URL.
 */

const SECRETO = 'app-secret-de-prueba';

function contexto(cuerpo: Buffer | undefined, firma?: string | string[]): ExecutionContext {
  const request = {
    rawBody: cuerpo,
    headers: firma === undefined ? {} : { 'x-hub-signature-256': firma },
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

/* Sin valor por defecto a propósito: `guard(undefined)` con un default caería
   en el default y probaría lo contrario de lo que dice el nombre del caso. */
function guard(secreto: string | undefined): MetaSignatureGuard {
  const config = { get: (clave: string) => (clave === 'META_APP_SECRET' ? secreto : undefined) };
  const instancia = new MetaSignatureGuard(config as ConfigService);
  /* Silencia el logger: estas pruebas provocan rechazos a propósito y el ruido
     tapa el resultado real de la corrida. */
  jest.spyOn(instancia['logger'], 'error').mockImplementation(() => undefined);
  jest.spyOn(instancia['logger'], 'warn').mockImplementation(() => undefined);
  return instancia;
}

function firmar(cuerpo: Buffer, secreto = SECRETO): string {
  return `sha256=${createHmac('sha256', secreto).update(cuerpo).digest('hex')}`;
}

const CUERPO = Buffer.from(
  JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [] }] }),
);

describe('MetaSignatureGuard', () => {
  it('acepta un payload firmado con el App Secret correcto', () => {
    expect(guard(SECRETO).canActivate(contexto(CUERPO, firmar(CUERPO)))).toBe(true);
  });

  it('rechaza una firma calculada con otro secreto', () => {
    expect(() => guard(SECRETO).canActivate(contexto(CUERPO, firmar(CUERPO, 'secreto-del-atacante')))).toThrow(
      ForbiddenException,
    );
  });

  it('rechaza si el cuerpo cambió después de firmarse', () => {
    const firma = firmar(CUERPO);
    const alterado = Buffer.from(JSON.stringify({ object: 'otra-cosa' }));
    expect(() => guard(SECRETO).canActivate(contexto(alterado, firma))).toThrow(ForbiddenException);
  });

  it('rechaza cuando no viene la cabecera X-Hub-Signature-256', () => {
    expect(() => guard(SECRETO).canActivate(contexto(CUERPO))).toThrow(ForbiddenException);
  });

  it('rechaza una cabecera sin el prefijo sha256=', () => {
    const soloHex = createHmac('sha256', SECRETO).update(CUERPO).digest('hex');
    expect(() => guard(SECRETO).canActivate(contexto(CUERPO, soloHex))).toThrow(ForbiddenException);
  });

  /* `timingSafeEqual` lanza TypeError si los buffers difieren en longitud, y
     `Buffer.from(hex,'hex')` trunca en silencio ante caracteres inválidos: sin
     el chequeo de longitud previo, esto sería un 500 en vez de un 403. */
  it('rechaza (sin reventar) una firma malformada o de otra longitud', () => {
    for (const basura of ['sha256=', 'sha256=zzzz', 'sha256=abcd', `sha256=${'a'.repeat(200)}`]) {
      expect(() => guard(SECRETO).canActivate(contexto(CUERPO, basura))).toThrow(ForbiddenException);
    }
  });

  it('toma el primer valor si la cabecera llega repetida', () => {
    expect(guard(SECRETO).canActivate(contexto(CUERPO, [firmar(CUERPO), 'sha256=basura']))).toBe(true);
  });

  /* Falla cerrado: sin secreto configurado no se procesa nada. Un modo
     "sin secreto, dejar pasar" habría dejado el agujero abierto para siempre. */
  it('rechaza todo si META_APP_SECRET no está configurado, aunque la firma sea coherente', () => {
    expect(() => guard(undefined).canActivate(contexto(CUERPO, firmar(CUERPO)))).toThrow(
      ForbiddenException,
    );
    expect(() => guard('').canActivate(contexto(CUERPO, firmar(CUERPO)))).toThrow(ForbiddenException);
  });

  it('rechaza si no hay cuerpo crudo (falta `rawBody: true` en main.ts)', () => {
    expect(() => guard(SECRETO).canActivate(contexto(undefined, firmar(CUERPO)))).toThrow(ForbiddenException);
    expect(() => guard(SECRETO).canActivate(contexto(Buffer.alloc(0), firmar(Buffer.alloc(0))))).toThrow(
      ForbiddenException,
    );
  });
});
