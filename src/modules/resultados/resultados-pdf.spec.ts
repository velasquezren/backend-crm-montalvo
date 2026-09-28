import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { ResultadosController } from './resultados.controller';
import { ResultadosService } from './resultados.service';

/**
 * El PDF tiene que salir por HTTP como PDF, y eso NO lo comprueba llamar al
 * service: el fallo estaba en la serialización de Nest.
 *
 * Devolviendo el Buffer a secas, Nest lo trataba como un objeto cualquiera y
 * respondía `{"type":"Buffer","data":[…]}`. Con la cabecera puesta a mano el
 * navegador recibía ese JSON creyendo que era un PDF y el visor fallaba con
 * «Se ha producido un error al cargar el documento PDF». Pasó en producción.
 */
const PDF = Buffer.from('%PDF-1.6\n%fixture\n');

@Module({
  controllers: [ResultadosController],
  providers: [{ provide: ResultadosService, useValue: { pdf: async () => PDF } }],
})
class ModuloPdf {}

describe('GET /resultados/:id/pdf por HTTP', () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    app = await NestFactory.create(ModuloPdf, { logger: false });
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  it('responde bytes de PDF, no un Buffer serializado como JSON', async () => {
    const r = await fetch(`${base}/resultados/11111111-1111-4111-8111-111111111111/pdf`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/pdf');

    const cuerpo = Buffer.from(await r.arrayBuffer());
    expect(cuerpo.subarray(0, 5).toString()).toBe('%PDF-');
    expect(cuerpo.equals(PDF)).toBe(true);
    /* La firma exacta del bug: si vuelve, el cuerpo es JSON. */
    expect(cuerpo.toString().startsWith('{"type":"Buffer"')).toBe(false);
  });

  it('se muestra en el navegador en vez de descargarse', async () => {
    const r = await fetch(`${base}/resultados/11111111-1111-4111-8111-111111111111/pdf`);
    expect(r.headers.get('content-disposition')).toContain('inline');
  });

  it('un id que no es UUID se rechaza antes de pedir nada', async () => {
    expect((await fetch(`${base}/resultados/no-es-uuid/pdf`)).status).toBe(400);
  });
});
