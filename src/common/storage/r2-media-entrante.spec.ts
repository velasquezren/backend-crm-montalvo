import { ConfigService } from '@nestjs/config';
import { R2Service } from './r2.service';

const config = new ConfigService({
  R2_ACCOUNT_ID: 'f06', R2_ACCESS_KEY_ID: 'clave-ficticia',
  R2_SECRET_ACCESS_KEY: 'secreto-ficticio', R2_BUCKET: 'bucket-ficticio',
});
afterEach(() => jest.restoreAllMocks());

describe('R2: transporte de recuperación de media', () => {
  it('firma la clave determinista y manda la misma señal de cancelación', async () => {
    const spy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(''));
    const signal = new AbortController().signal;
    await new R2Service(config).subirMediaEntrante('wa/chat/mensaje', new ArrayBuffer(2), 'image/jpeg', signal);
    expect(spy).toHaveBeenCalledTimes(1);
    const [request, init] = spy.mock.calls[0]!;
    expect(request).toBeInstanceOf(Request);
    expect((request as Request).url).toBe('https://f06.r2.cloudflarestorage.com/bucket-ficticio/wa/chat/mensaje');
    expect((request as Request).headers.get('if-none-match')).toBe('*');
    expect(init?.signal).toBe(signal);
  });
  it('503 no dispara reintentos ocultos y no copia el cuerpo de error', async () => {
    const spy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('token=secreto', { status: 503 }));
    await expect(new R2Service(config).subirMediaEntrante('wa/c/m', new ArrayBuffer(0), 'image/jpeg', new AbortController().signal))
      .rejects.toMatchObject({ codigo: 'R2_HTTP_503', categoria: 'TRANSITORIO', message: 'R2_HTTP_503' });
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it('412 significa que la clave inmutable ya se publicó en un intento anterior', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('', { status: 412 }));
    await expect(new R2Service(config).subirMediaEntrante('wa/c/m', new ArrayBuffer(0), 'image/jpeg', new AbortController().signal))
      .resolves.toBeUndefined();
  });
  it('una señal abortada no inicia la subida', async () => {
    const spy = jest.spyOn(global, 'fetch');
    const controller = new AbortController();
    controller.abort();
    await expect(new R2Service(config).subirMediaEntrante('wa/c/m', new ArrayBuffer(0), 'image/jpeg', controller.signal))
      .rejects.toMatchObject({ codigo: 'TIEMPO_AGOTADO' });
    expect(spy).not.toHaveBeenCalled();
  });
  it('configuración ausente rechaza explícitamente, nunca asegura una subida inexistente', async () => {
    const spy = jest.spyOn(global, 'fetch');
    await expect(new R2Service(new ConfigService({})).subirMediaEntrante('wa/c/m', new ArrayBuffer(0), 'image/jpeg', new AbortController().signal))
      .rejects.toMatchObject({ codigo: 'R2_SIN_CONFIGURAR', categoria: 'CONFIGURACION' });
    expect(spy).not.toHaveBeenCalled();
  });
});
