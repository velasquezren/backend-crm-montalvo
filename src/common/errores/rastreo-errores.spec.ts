import * as Sentry from '@sentry/node';

import { iniciarRastreoDeErrores, limpiarEvento, redactar, reportarError } from './rastreo-errores';

describe('redactar', () => {
  it('enmascara lo que identifica a alguien y deja lo que dice qué falló', () => {
    const texto = 'Meta devolvió 400 a un text para +591 700-12345 (ana.perez@correo.com) BO.13491208655302741918 '
      + 'Bearer EAAGm0PX4ZCpsBA eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123: (#131026) Message undeliverable';
    const limpio = redactar(texto);
    for (const dato of ['700-12345', 'ana.perez@correo.com', 'BO.1349120865', 'EAAGm0PX4ZCpsBA', 'eyJhbGci']) expect(limpio).not.toContain(dato);
    expect(limpio).toContain('Meta devolvió 400 a un text');
    expect(limpio).toContain('(#131026) Message undeliverable');
  });
});

describe('iniciarRastreoDeErrores', () => {
  it('sin SENTRY_DSN, o en las pruebas, queda apagado y reportar no hace nada', () => {
    expect(iniciarRastreoDeErrores({ NODE_ENV: 'production' })).toBe(false);
    expect(iniciarRastreoDeErrores({ NODE_ENV: 'test', SENTRY_DSN: 'http://clave@127.0.0.1/1' })).toBe(false);
    expect(() => reportarError(new Error('x'), { origen: 'prueba' })).not.toThrow();
  });
});

/*
 * El SDK real arma el evento y `limpiarEvento` lo filtra antes de enviarlo: se
 * captura lo que saldría por la red con un transporte propio. No se usa
 * `iniciarRastreoDeErrores` porque instala manejadores globales del proceso
 * (excepción no capturada, rechazo sin manejar) que dentro de Jest tumbarían la
 * suite entera; su `beforeSend` es este mismo `limpiarEvento`.
 */
describe('lo que sale del servidor con un error real', () => {
  const enviados: string[] = [];

  beforeAll(() => {
    Sentry.init({
      dsn: 'http://clave@127.0.0.1/1',
      defaultIntegrations: false,
      integrations: [Sentry.linkedErrorsIntegration()],
      beforeSend: evento => limpiarEvento(evento),
      transport: opciones => Sentry.createTransport(opciones, async peticion => {
        enviados.push(typeof peticion.body === 'string' ? peticion.body : Buffer.from(peticion.body).toString('utf8'));
        return { statusCode: 200 };
      }),
    });
  });
  afterAll(async () => {
    await Sentry.close();
  });

  it('lleva el error, su stack y dónde pasó; no lleva petición, usuario ni datos de la paciente', async () => {
    Sentry.withScope(alcance => {
      alcance.setUser({ id: 'usuario-1', email: 'agente@clinica.local' });
      alcance.setExtra('cuerpo', { telefono: '+59170012345' });
      alcance.setTag('origen', 'POST /conversaciones/:id/mensajes');
      Sentry.captureException(new Error('No se pudo enviar a +59170012345 (ana@correo.com)'));
    });
    await Sentry.flush(2_000);

    const sobre = enviados.join('\n');
    expect(sobre).toContain('No se pudo enviar a [número] ([correo])');
    expect(sobre).toContain('POST /conversaciones/:id/mensajes');
    expect(sobre).toContain('stacktrace');
    for (const dato of ['70012345', 'ana@correo.com', 'agente@clinica.local', 'usuario-1', '"cuerpo"']) expect(sobre).not.toContain(dato);
  });
});
