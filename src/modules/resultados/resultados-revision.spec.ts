import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { ResultadosController } from './resultados.controller';
import { ResultadosService } from './resultados.service';

/**
 * «Ver el informe» ya no trae el PDF: pide un enlace a la vista del portal y
 * el navegador lo abre allí, con el visor del médico y la versión liviana.
 *
 * Antes el CRM bajaba el PDF del portal y lo reenviaba entero (3-5 MB de
 * fotos de ecografía) antes de que se viera nada. Esta prueba fija que el CRM
 * solo entrega el enlace, y que la ruta vieja del PDF no vuelve.
 */
const ENLACE = { url: 'https://resultados.example/revision/firma', expiraEn: '2026-09-30T00:10:00.000Z' };

@Module({
  controllers: [ResultadosController],
  providers: [{ provide: ResultadosService, useValue: { enlaceRevision: async () => ENLACE } }],
})
class ModuloRevision {}

describe('POST /resultados/:id/revision por HTTP', () => {
  let app: INestApplication;
  let base: string;
  const id = '11111111-1111-4111-8111-111111111111';

  beforeAll(async () => {
    app = await NestFactory.create(ModuloRevision, { logger: false });
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  it('devuelve el enlace a la vista del portal, no el PDF', async () => {
    const r = await fetch(`${base}/resultados/${id}/revision`, { method: 'POST' });
    expect(r.ok).toBe(true);
    expect(r.headers.get('content-type')).toContain('application/json');
    expect(await r.json()).toEqual(ENLACE);
  });

  it('el CRM ya no sirve el PDF', async () => {
    expect((await fetch(`${base}/resultados/${id}/pdf`)).status).toBe(404);
  });

  it('un id que no es UUID se rechaza antes de pedir nada', async () => {
    expect((await fetch(`${base}/resultados/no-es-uuid/revision`, { method: 'POST' })).status).toBe(400);
  });
});
