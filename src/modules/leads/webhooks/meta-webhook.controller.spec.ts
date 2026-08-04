import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { MetaWebhookController } from './meta-webhook.controller';

/**
 * El webhook de Lead Ads tenía los dos mismos agujeros que el de WhatsApp:
 * POST público sin verificar la firma de Meta, y un `verificar()` que con
 * META_VERIFY_TOKEN ausente comparaba `undefined === undefined`. Hoy solo
 * registra en el log, pero en cuanto se implemente el TODO de resolver el
 * leadgen_id pasa a escribir en base — para entonces el agujero ya no está.
 */

function montar(config: Record<string, string> = {}) {
  const controller = new MetaWebhookController({
    get: (clave: string) => config[clave],
  } as ConfigService);
  jest.spyOn(controller['logger'], 'error').mockImplementation(() => undefined);
  jest.spyOn(controller['logger'], 'log').mockImplementation(() => undefined);
  return controller;
}

describe('MetaWebhookController (Lead Ads)', () => {
  describe('verificación de la suscripción', () => {
    it('devuelve el challenge con el token correcto', () => {
      expect(montar({ META_VERIFY_TOKEN: 'secreto' }).verificar('subscribe', 'secreto', 'reto')).toBe('reto');
    });

    it('rechaza un token incorrecto', () => {
      expect(() => montar({ META_VERIFY_TOKEN: 'secreto' }).verificar('subscribe', 'otro', 'x')).toThrow(
        ForbiddenException,
      );
    });

    it('rechaza si META_VERIFY_TOKEN no está configurado', () => {
      expect(() =>
        montar({}).verificar('subscribe', undefined as unknown as string, 'x'),
      ).toThrow(ForbiddenException);
    });
  });

  describe('recepción de leads', () => {
    it('responde 200 rápido y cuenta los leadgen_id del lote', () => {
      const controller = montar();
      const log = jest.spyOn(controller['logger'], 'log');

      const resultado = controller.recibir({
        entry: [
          {
            changes: [
              { field: 'leadgen', value: { leadgen_id: 'lead-1' } },
              { field: 'leadgen', value: { leadgen_id: 'lead-2' } },
              /* Ruido: Meta manda cambios de otros campos por la misma tubería. */
              { field: 'feed', value: {} },
            ],
          },
        ],
      });

      expect(resultado).toEqual({ received: true });
      expect(log).toHaveBeenCalledWith(expect.stringContaining('2 lead(s)'));
    });

    it('no explota con un payload vacío o sin las claves esperadas', () => {
      expect(montar().recibir({})).toEqual({ received: true });
      expect(montar().recibir({ entry: [{}] })).toEqual({ received: true });
      expect(montar().recibir({ entry: [{ changes: [{ field: 'leadgen' }] }] })).toEqual({
        received: true,
      });
    });
  });
});
