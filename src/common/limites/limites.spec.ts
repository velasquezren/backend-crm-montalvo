import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { Controller, Get, INestApplication, Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { HealthController } from '../health/health.controller';
import { AgendaFlowController } from '../../modules/agenda/agenda-flow.controller';
import { HorarioFilemakerController } from '../../modules/agenda/horario-filemaker.controller';
import { WhatsappWebhookController } from '../../modules/conversaciones/webhooks/whatsapp-webhook.controller';
import { MetaWebhookController } from '../../modules/leads/webhooks/meta-webhook.controller';
import { ResultadosFilemakerController } from '../../modules/resultados/resultados-filemaker.controller';
import { LIMITE_GENERAL, LIMITES_GLOBALES, Limite, SinLimite } from './limites';

/**
 * Los decoradores del throttler se aplican por NOMBRE. Un nombre que no coincide
 * con el throttler global no falla: se ignora en silencio. Estas pruebas cubren
 * el comportamiento real con el guard de la librería, el cableado de los
 * controladores que dependen de él y que nadie vuelva a usar los decoradores
 * de la librería directamente.
 */

const SKIP = `THROTTLER:SKIP${LIMITE_GENERAL}`;
const LIMIT = `THROTTLER:LIMIT${LIMITE_GENERAL}`;

describe('límites de peticiones', () => {
  describe('con el guard real y la configuración global', () => {
    @Controller()
    class Sonda {
      @Get('libre') @SinLimite() libre() { return 'ok'; }
      @Get('estricto') @Limite(2, 60_000) estricto() { return 'ok'; }
      @Get('general') general() { return 'ok'; }
    }

    @Module({
      imports: [ThrottlerModule.forRoot(LIMITES_GLOBALES)],
      controllers: [Sonda],
      providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
    })
    class ModuloSonda {}

    let app: INestApplication;
    let base: string;

    beforeAll(async () => {
      app = await NestFactory.create(ModuloSonda, { logger: false });
      await app.listen(0, '127.0.0.1');
      base = await app.getUrl();
    });
    afterAll(() => app.close());

    async function estados(ruta: string, veces: number): Promise<number[]> {
      const codigos: number[] = [];
      for (let i = 0; i < veces; i++) codigos.push((await fetch(`${base}/${ruta}`)).status);
      return codigos;
    }

    it('SinLimite exime de verdad del límite global', async () => {
      const limiteGlobal = LIMITES_GLOBALES[0].limit;
      const codigos = await estados('libre', limiteGlobal + 5);
      expect(codigos.every(c => c === 200)).toBe(true);
    });

    it('Limite sustituye el global por uno más estricto', async () => {
      expect(await estados('estricto', 4)).toEqual([200, 200, 429, 429]);
    });

    it('sin decorador se aplica el límite global', async () => {
      const limiteGlobal = LIMITES_GLOBALES[0].limit;
      const codigos = await estados('general', limiteGlobal + 1);
      expect(codigos.at(-1)).toBe(429);
    });
  });

  it('los webhooks de Meta, el Flow y health van sin límite', () => {
    for (const clase of [WhatsappWebhookController, MetaWebhookController, AgendaFlowController, HealthController]) {
      expect({ clase: clase.name, exento: Reflect.getMetadata(SKIP, clase) }).toEqual({ clase: clase.name, exento: true });
    }
  });

  it('FileMaker conserva sus límites documentados (30 y 60 por minuto)', () => {
    const resultados = ResultadosFilemakerController.prototype;
    for (const metodo of ['avisar', 'destino', 'cambiarTelefono'] as const) {
      expect(Reflect.getMetadata(LIMIT, resultados[metodo])).toBe(30);
    }
    expect(Reflect.getMetadata(LIMIT, HorarioFilemakerController.prototype.sincronizar)).toBe(60);
  });

  it('nadie usa SkipThrottle/Throttle de la librería fuera de limites.ts', () => {
    const raiz = join(__dirname, '..', '..');
    const infractores: string[] = [];
    const recorrer = (dir: string): void => {
      for (const nombre of readdirSync(dir)) {
        const ruta = join(dir, nombre);
        if (statSync(ruta).isDirectory()) {
          if (nombre !== 'generated') recorrer(ruta);
        } else if (nombre.endsWith('.ts') && !nombre.endsWith('.spec.ts') && !ruta.endsWith(join('limites', 'limites.ts'))) {
          if (/import\s*\{[^}]*\b(SkipThrottle|Throttle)\b[^}]*\}\s*from\s*'@nestjs\/throttler'/.test(readFileSync(ruta, 'utf8'))) {
            infractores.push(relative(raiz, ruta));
          }
        }
      }
    };
    recorrer(raiz);
    expect(infractores).toEqual([]);
  });
});
