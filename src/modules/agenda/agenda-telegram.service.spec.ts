import { ConfigService } from '@nestjs/config';
import { AgendaTelegramService } from './agenda-telegram.service';

describe('aviso de Telegram de la agenda', () => {
  afterEach(() => jest.restoreAllMocks());

  it('manda el mismo texto que ScriptCase, con el nombre escapado para Markdown', async () => {
    const llamada = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    new AgendaTelegramService(new ConfigService({ AGENDA_TELEGRAM_TOKEN: '123:abc', AGENDA_TELEGRAM_CHAT: '-100' }))
      .nuevaCita('Ana *Rojas*_[x]', '1234567 SC');
    await new Promise(r => setImmediate(r));
    const [url, opciones] = llamada.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/bot123:abc/sendMessage');
    expect(JSON.parse(opciones.body as string)).toEqual({
      chat_id: '-100', parse_mode: 'Markdown',
      text: '*🏥 NUEVA CITA REGISTRADA*\n\n*Paciente:* Ana \\*Rojas\\*\\_\\[x\\]\n*Carnet:* 1234567 SC\n*Estado:* PENDIENTE',
    });
  });

  it('sin token o sin chat no avisa', () => {
    const llamada = jest.spyOn(global, 'fetch');
    new AgendaTelegramService(new ConfigService({ AGENDA_TELEGRAM_TOKEN: '123:abc' })).pagoParaVerificar('Ana', '1');
    expect(llamada).not.toHaveBeenCalled();
  });
});
