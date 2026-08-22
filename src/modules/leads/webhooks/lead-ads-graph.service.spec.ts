import { ConfigService } from '@nestjs/config';

import { LeadAdsGraphService } from './lead-ads-graph.service';

/**
 * Igual criterio que whatsapp-cloud.service.spec.ts: esto habla con un
 * tercero (Graph API), así que se simula `fetch` — la regla de "nada de
 * mocks" es sobre Postgres, no sobre una llamada de red a Meta.
 */

function servicio(config: Record<string, string> = {}): LeadAdsGraphService {
  const s = new LeadAdsGraphService({ get: (clave: string) => config[clave] } as ConfigService);
  jest.spyOn(s['logger'], 'error').mockImplementation(() => undefined);
  jest.spyOn(s['logger'], 'warn').mockImplementation(() => undefined);
  return s;
}

const CON_TOKEN = { PAGE_ACCESS_TOKEN: 'tok-pagina' };

function respuestaGraph(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      field_data: [
        { name: 'full_name', values: ['Ana Pérez'] },
        { name: 'phone_number', values: ['+59170000001'] },
      ],
      ad_id: 'ad-123',
      form_id: 'form-456',
      platform: 'fb',
      ...overrides,
    }),
  };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('LeadAdsGraphService', () => {
  describe('credenciales', () => {
    it('sin PAGE_ACCESS_TOKEN queda deshabilitado y no llama a nadie', async () => {
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy as unknown as typeof fetch;

      expect(servicio({}).habilitado).toBe(false);
      expect(await servicio({}).resolverLead('lead-1')).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('resolverLead', () => {
    it('arma la URL y la cabecera Authorization correctamente', async () => {
      const fetchSpy = jest.fn().mockResolvedValue(respuestaGraph());
      global.fetch = fetchSpy as unknown as typeof fetch;

      await servicio(CON_TOKEN).resolverLead('lead-1');

      const [url, opciones] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://graph.facebook.com/v25.0/lead-1?fields=field_data,ad_id,form_id,platform');
      expect(opciones.headers.Authorization).toBe('Bearer tok-pagina');
    });

    it('extrae nombre, teléfono, origen (fb) y anuncioId', async () => {
      global.fetch = jest.fn().mockResolvedValue(respuestaGraph()) as unknown as typeof fetch;

      const resuelto = await servicio(CON_TOKEN).resolverLead('lead-1');

      expect(resuelto).toEqual({
        nombre: 'Ana Pérez',
        telefono: '+59170000001',
        origen: 'FACEBOOK_LEAD_AD',
        anuncioId: 'ad-123',
      });
    });

    it('platform=ig se traduce a INSTAGRAM_LEAD_AD', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValue(respuestaGraph({ platform: 'ig' })) as unknown as typeof fetch;

      const resuelto = await servicio(CON_TOKEN).resolverLead('lead-1');
      expect(resuelto?.origen).toBe('INSTAGRAM_LEAD_AD');
    });

    it('compone el nombre desde first_name + last_name si no hay full_name', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        respuestaGraph({
          field_data: [
            { name: 'first_name', values: ['Ana'] },
            { name: 'last_name', values: ['Pérez'] },
            { name: 'phone_number', values: ['+59170000001'] },
          ],
        }),
      ) as unknown as typeof fetch;

      const resuelto = await servicio(CON_TOKEN).resolverLead('lead-1');
      expect(resuelto?.nombre).toBe('Ana Pérez');
    });

    it('busca un campo de teléfono con nombre no estándar como respaldo', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        respuestaGraph({
          field_data: [
            { name: 'full_name', values: ['Ana Pérez'] },
            { name: 'whatsapp_phone', values: ['+59170000001'] },
          ],
        }),
      ) as unknown as typeof fetch;

      const resuelto = await servicio(CON_TOKEN).resolverLead('lead-1');
      expect(resuelto?.telefono).toBe('+59170000001');
    });

    it('null si el formulario no trae ni nombre ni teléfono reconocibles', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        respuestaGraph({ field_data: [{ name: 'pregunta_rara', values: ['x'] }] }),
      ) as unknown as typeof fetch;

      expect(await servicio(CON_TOKEN).resolverLead('lead-1')).toBeNull();
    });

    it('null si Graph API rechaza, sin lanzar', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValue({ ok: false, status: 400, text: async () => 'token vencido' }) as unknown as typeof fetch;

      await expect(servicio(CON_TOKEN).resolverLead('lead-1')).resolves.toBeNull();
    });

    it('null si la red falla, sin lanzar', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('sin red')) as unknown as typeof fetch;

      await expect(servicio(CON_TOKEN).resolverLead('lead-1')).resolves.toBeNull();
    });
  });
});
