import { Prisma } from '../../prisma/prisma-client';
import { errorAltaSanitizado, proximoIntentoAlta } from './primer-contacto.service';

test('backoff creciente con techo horario para una obligación comercial durable', () => {
  const inicio = new Date('2026-09-14T00:00:00Z');
  expect([1, 2, 3, 4, 5, 100].map(n => (proximoIntentoAlta(n, inicio).getTime() - inicio.getTime()) / 60_000))
    .toEqual([1, 5, 15, 60, 60, 60]);
});

test('no registra payloads ni mensajes SQL', () => {
  expect(errorAltaSanitizado(new Error('paciente-token-url'))).toBe('ALTA_NO_COMPLETADA');
  expect(errorAltaSanitizado(new Prisma.PrismaClientKnownRequestError('paciente-token-url', {
    code: 'P2002', clientVersion: 'test', meta: { secreto: 'no registrar' },
  }))).toBe('POSTGRES_P2002');
});
