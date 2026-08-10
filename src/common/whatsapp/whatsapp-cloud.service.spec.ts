import { ConfigService } from '@nestjs/config';

import { WhatsappCloudService } from './whatsapp-cloud.service';

/**
 * Este camino —el que habla con Meta— no tenía ni una prueba: estaba repetido en
 * cuatro métodos y nadie lo ejercitaba. Al centralizarlo se puede cubrir, y aquí
 * sí se simula `fetch`: es red hacia un tercero, no la base de datos. La regla de
 * "nada de mocks" es sobre Postgres, y mandar mensajes de verdad a WhatsApp en
 * cada corrida de pruebas no es una opción.
 */

function servicio(config: Record<string, string> = {}): WhatsappCloudService {
  const s = new WhatsappCloudService({
    get: (clave: string) => config[clave],
  } as ConfigService);
  jest.spyOn(s['logger'], 'error').mockImplementation(() => undefined);
  jest.spyOn(s['logger'], 'warn').mockImplementation(() => undefined);
  return s;
}

const CREDENCIALES = { WHATSAPP_TOKEN: 'tok', WHATSAPP_PHONE_ID: '123' };

/** Respuesta de Meta cuando acepta el mensaje. */
function respuestaOk(id = 'wamid.abc') {
  return { ok: true, status: 200, json: async () => ({ messages: [{ id }] }) };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('WhatsappCloudService', () => {
  describe('credenciales', () => {
    it('sin token o sin phoneId queda deshabilitado y no llama a nadie', async () => {
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy as unknown as typeof fetch;

      expect(servicio({}).habilitado).toBe(false);
      expect(servicio({ WHATSAPP_TOKEN: 'tok' }).habilitado).toBe(false);
      expect(servicio({ WHATSAPP_PHONE_ID: '123' }).habilitado).toBe(false);

      expect(await servicio({}).enviar('+59170000001', { type: 'text', text: { body: 'x' } })).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    /* El `.env` de producción tiene los dos nombres de cada par por historia.
       Se resuelven aquí y en ningún otro sitio: antes se leían en cuatro
       métodos y rotar solo uno dejaba envíos usando el viejo en silencio. */
    it('acepta los dos nombres de cada variable', () => {
      expect(servicio(CREDENCIALES).habilitado).toBe(true);
      expect(
        servicio({ WHATSAPP_ACCESS_TOKEN: 'tok', WHATSAPP_PHONE_NUMBER_ID: '123' }).habilitado,
      ).toBe(true);
    });
  });

  describe('enviar', () => {
    it('manda el número sin + y devuelve el id de Meta', async () => {
      const fetchSpy = jest.fn().mockResolvedValue(respuestaOk('wamid.xyz'));
      global.fetch = fetchSpy as unknown as typeof fetch;

      const id = await servicio(CREDENCIALES).enviar('+591 70000001', {
        type: 'text',
        text: { body: 'Hola' },
      });

      expect(id).toBe('wamid.xyz');
      const [url, opciones] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://graph.facebook.com/v25.0/123/messages');
      const cuerpo = JSON.parse(opciones.body);
      expect(cuerpo.to).toBe('59170000001');
      expect(cuerpo.messaging_product).toBe('whatsapp');
      expect(cuerpo.type).toBe('text');
      expect(opciones.headers.Authorization).toBe('Bearer tok');
    });

    it('pasa tal cual el contenido interactivo', async () => {
      const fetchSpy = jest.fn().mockResolvedValue(respuestaOk());
      global.fetch = fetchSpy as unknown as typeof fetch;

      await servicio(CREDENCIALES).enviar('+59170000001', {
        type: 'interactive',
        interactive: { type: 'button', body: { text: 'Hola' } },
      });

      const cuerpo = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(cuerpo.interactive.type).toBe('button');
    });

    /* `null` es "no salió". Nunca lanza: un problema con Meta no puede tumbar
       la operación de negocio, que ya está guardada en base. */
    it('devuelve null si Meta rechaza, sin lanzar', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => 'error de Meta',
      }) as unknown as typeof fetch;

      await expect(
        servicio(CREDENCIALES).enviar('+59170000001', { type: 'text', text: { body: 'x' } }),
      ).resolves.toBeNull();
    });

    it('devuelve null si la red falla, sin lanzar', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('sin red')) as unknown as typeof fetch;

      await expect(
        servicio(CREDENCIALES).enviar('+59170000001', { type: 'text', text: { body: 'x' } }),
      ).resolves.toBeNull();
    });

    it('devuelve null si Meta responde 200 pero sin id', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }) as unknown as typeof fetch;

      await expect(
        servicio(CREDENCIALES).enviar('+59170000001', { type: 'text', text: { body: 'x' } }),
      ).resolves.toBeNull();
    });
  });

  describe('marcarLeido', () => {
    it('manda el id del mensaje y el indicador solo si se pide', async () => {
      const fetchSpy = jest.fn().mockResolvedValue({ ok: true, status: 200 });
      global.fetch = fetchSpy as unknown as typeof fetch;
      const s = servicio(CREDENCIALES);

      await s.marcarLeido('wamid.in', false);
      expect(JSON.parse(fetchSpy.mock.calls[0][1].body).typing_indicator).toBeUndefined();

      await s.marcarLeido('wamid.in', true);
      expect(JSON.parse(fetchSpy.mock.calls[1][1].body).typing_indicator).toEqual({ type: 'text' });
    });

    it('no lanza si Meta falla', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('x')) as unknown as typeof fetch;
      await expect(servicio(CREDENCIALES).marcarLeido('wamid.in')).resolves.toBeUndefined();
    });
  });

  describe('media', () => {
    it('resuelve la URL temporal del media', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ url: 'https://cdn.meta/x' }),
      }) as unknown as typeof fetch;

      expect(await servicio(CREDENCIALES).urlDeMedia('media-1')).toBe('https://cdn.meta/x');
    });

    it('null si Meta no la da', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404 }) as unknown as typeof fetch;
      expect(await servicio(CREDENCIALES).urlDeMedia('media-1')).toBeNull();
    });

    /* El CDN de Meta también exige el token: sin él la descarga da 401. */
    it('descarga con el token en la cabecera', async () => {
      const fetchSpy = jest.fn().mockResolvedValue({ ok: true });
      global.fetch = fetchSpy as unknown as typeof fetch;

      await servicio(CREDENCIALES).descargarMedia('https://cdn.meta/x');

      expect(fetchSpy.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
    });
  });
});
