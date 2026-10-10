import { ConfigService } from '@nestjs/config';

import { ClienteVertex, ConfiguracionIA } from './proveedor-vertex';

/*
 * Dos maneras de llamar a Gemini: Vertex (proyecto + cuenta de servicio) y la API
 * con clave, para probar sin Google Cloud. La clave manda si está, y la API con
 * clave RECHAZA con 400 las etiquetas de facturación, que son de Vertex.
 */
const cfg = (v: Record<string, string>) => new ConfiguracionIA(new ConfigService(v));

describe('ConfiguracionIA: Vertex o clave de API', () => {
  it('con clave de API está lista sin proyecto ni cuenta de servicio; apagada, no', () => {
    expect(cfg({ ASISTENTE_IA: 'on', GEMINI_API_KEY: 'k' }).estado()).toMatchObject({ listo: true, claveApi: true, proyecto: false });
    expect(cfg({ GEMINI_API_KEY: 'k' }).estado().listo).toBe(false);
  });
  it('sin clave sigue exigiendo el proyecto, como siempre', () => {
    expect(cfg({ ASISTENTE_IA: 'on', GOOGLE_CLOUD_PROJECT: 'p' }).estado()).toMatchObject({ listo: true, claveApi: false });
    expect(cfg({ ASISTENTE_IA: 'on' }).estado().listo).toBe(false);
    expect(cfg({ ASISTENTE_IA: 'on', GOOGLE_CLOUD_PROJECT: 'p', GOOGLE_APPLICATION_CREDENTIALS: '/no/existe.json' }).estado().listo).toBe(false);
  });
});

describe('ClienteVertex: etiquetas según la vía', () => {
  async function llamar(v: Record<string, string>) {
    const cliente = new ClienteVertex(cfg({ ASISTENTE_IA: 'on', ...v }));
    const generateContent = jest.fn().mockResolvedValue({});
    (cliente as unknown as { cliente: unknown }).cliente = { models: { generateContent } };
    await cliente.generar({ model: 'm', contents: [], config: { labels: { uso: 'conversar' }, temperature: 0.2 } }, 1000);
    return generateContent.mock.calls[0][0].config as Record<string, unknown>;
  }
  it('con clave de API no se manda ninguna etiqueta, pero sí lo demás', async () => {
    const c = await llamar({ GEMINI_API_KEY: 'k' });
    expect(c).not.toHaveProperty('labels');
    expect(c).toMatchObject({ temperature: 0.2, httpOptions: { timeout: 1000 } });
  });
  it('con Vertex se etiqueta el uso para la factura', async () => {
    expect(await llamar({ GOOGLE_CLOUD_PROJECT: 'p' })).toMatchObject({ labels: { aplicacion: 'crm-montalvo', uso: 'conversar' } });
  });
});
