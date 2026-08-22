import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { LeadsService } from '../leads.service';
import { LeadAdsGraphService } from './lead-ads-graph.service';
import { MetaWebhookController } from './meta-webhook.controller';

/**
 * El webhook de Lead Ads tenía los dos mismos agujeros que el de WhatsApp:
 * POST público sin verificar la firma de Meta, y un `verificar()` que con
 * META_VERIFY_TOKEN ausente comparaba `undefined === undefined`. Eso ya
 * estaba cerrado. Lo que faltaba era conectar la resolución real: ahora que
 * `recibir()` sí escribe en base (vía LeadAdsGraphService + LeadsService), un
 * lead que falle al resolverse no puede llevarse el resto del lote —mismo
 * criterio que whatsapp-webhook.controller.spec.ts.
 */

interface ServicioGraph {
  resolverLead: jest.Mock;
}

interface ServicioLeads {
  procesarLeadMeta: jest.Mock;
}

function montar(config: Record<string, string> = {}) {
  const graph: ServicioGraph = { resolverLead: jest.fn() };
  const leads: ServicioLeads = { procesarLeadMeta: jest.fn().mockResolvedValue({ id: 'lead-creado' }) };

  const controller = new MetaWebhookController(
    { get: (clave: string) => config[clave] } as ConfigService,
    graph as unknown as LeadAdsGraphService,
    leads as unknown as LeadsService,
  );
  jest.spyOn(controller['logger'], 'error').mockImplementation(() => undefined);
  jest.spyOn(controller['logger'], 'log').mockImplementation(() => undefined);
  return { controller, graph, leads };
}

function payloadConLeads(...leadgenIds: string[]) {
  return {
    entry: [
      {
        changes: leadgenIds.map(id => ({ field: 'leadgen', value: { leadgen_id: id } })),
      },
    ],
  };
}

describe('MetaWebhookController (Lead Ads)', () => {
  describe('verificación de la suscripción', () => {
    it('devuelve el challenge con el token correcto', () => {
      expect(montar({ META_VERIFY_TOKEN: 'secreto' }).controller.verificar('subscribe', 'secreto', 'reto')).toBe(
        'reto',
      );
    });

    it('rechaza un token incorrecto', () => {
      expect(() =>
        montar({ META_VERIFY_TOKEN: 'secreto' }).controller.verificar('subscribe', 'otro', 'x'),
      ).toThrow(ForbiddenException);
    });

    it('rechaza si META_VERIFY_TOKEN no está configurado', () => {
      expect(() =>
        montar({}).controller.verificar('subscribe', undefined as unknown as string, 'x'),
      ).toThrow(ForbiddenException);
    });
  });

  describe('recibir', () => {
    it('responde 200 rápido sin esperar a que se resuelvan los leads', () => {
      const { controller, graph } = montar();
      graph.resolverLead.mockReturnValue(new Promise(() => undefined)); // nunca se resuelve

      const resultado = controller.recibir(payloadConLeads('lead-1'));

      expect(resultado).toEqual({ received: true });
    });

    it('no explota con un payload vacío o sin las claves esperadas', () => {
      const { controller } = montar();
      expect(controller.recibir({})).toEqual({ received: true });
      expect(controller.recibir({ entry: [{}] })).toEqual({ received: true });
      expect(controller.recibir({ entry: [{ changes: [{ field: 'leadgen' }] }] })).toEqual({
        received: true,
      });
    });
  });

  describe('procesarWebhook', () => {
    it('resuelve cada leadgen_id y delega en LeadsService.procesarLeadMeta', async () => {
      const { controller, graph, leads } = montar();
      graph.resolverLead.mockResolvedValue({
        nombre: 'Ana Pérez',
        telefono: '+59170000001',
        origen: 'FACEBOOK_LEAD_AD',
        anuncioId: 'ad-123',
      });

      await controller.procesarWebhook(payloadConLeads('lead-1'));

      expect(graph.resolverLead).toHaveBeenCalledWith('lead-1');
      expect(leads.procesarLeadMeta).toHaveBeenCalledWith({
        nombre: 'Ana Pérez',
        telefono: '+59170000001',
        origen: 'FACEBOOK_LEAD_AD',
        metaLeadId: 'lead-1',
        anuncioId: 'ad-123',
      });
    });

    it('ignora los que Graph API no pudo resolver, sin llamar a LeadsService', async () => {
      const { controller, graph, leads } = montar();
      graph.resolverLead.mockResolvedValue(null);

      await controller.procesarWebhook(payloadConLeads('lead-1'));

      expect(leads.procesarLeadMeta).not.toHaveBeenCalled();
    });

    it('ignora los cambios de otros campos (ruido de la misma tubería)', async () => {
      const { controller, graph, leads } = montar();

      await controller.procesarWebhook({ entry: [{ changes: [{ field: 'feed', value: {} }] }] });

      expect(graph.resolverLead).not.toHaveBeenCalled();
      expect(leads.procesarLeadMeta).not.toHaveBeenCalled();
    });

    /* El corazón de esta prueba: un lead que revienta (Graph API cae a mitad
       del lote, o procesarLeadMeta lanza) no se lleva a los demás. */
    it('un lead que falla no se lleva al resto del lote', async () => {
      const { controller, graph, leads } = montar();
      graph.resolverLead
        .mockResolvedValueOnce({
          nombre: 'Ana',
          telefono: '+59170000001',
          origen: 'FACEBOOK_LEAD_AD' as const,
        })
        .mockRejectedValueOnce(new Error('Graph API caída'))
        .mockResolvedValueOnce({
          nombre: 'Bea',
          telefono: '+59170000002',
          origen: 'INSTAGRAM_LEAD_AD' as const,
        });

      await controller.procesarWebhook(payloadConLeads('lead-1', 'lead-2', 'lead-3'));

      expect(leads.procesarLeadMeta).toHaveBeenCalledTimes(2);
      expect(leads.procesarLeadMeta).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ metaLeadId: 'lead-1' }),
      );
      expect(leads.procesarLeadMeta).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ metaLeadId: 'lead-3' }),
      );
    });
  });
});
