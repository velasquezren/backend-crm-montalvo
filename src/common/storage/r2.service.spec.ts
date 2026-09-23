import { ConfigService } from '@nestjs/config';

import { R2Service } from './r2.service';

/**
 * La URL firmada de una misma clave tiene que ser IDÉNTICA durante una hora:
 * si cambia en cada petición, el navegador vuelve a descargar todas las fotos
 * del chat cada vez que se abre o se recarga (el parpadeo con muchas imágenes).
 * Se prueba con credenciales falsas: firmar es cálculo local, no red.
 */
describe('R2Service.urlFirmada', () => {
  const r2 = new R2Service(
    new ConfigService({ R2_ACCOUNT_ID: 'cuenta', R2_ACCESS_KEY_ID: 'id', R2_SECRET_ACCESS_KEY: 'secreto', R2_BUCKET: 'bucket' }),
  );
  const hora = Date.UTC(2026, 8, 23, 19, 0, 0);

  it('dentro de la misma hora da la misma URL', async () => {
    const a = await r2.urlFirmada('wa/c/m.jpg', 3600, hora + 60_000);
    const b = await r2.urlFirmada('wa/c/m.jpg', 3600, hora + 59 * 60_000);
    expect(a).toBe(b);
  });

  it('en la hora siguiente cambia, y nunca da menos validez que la pedida', async () => {
    const a = await r2.urlFirmada('wa/c/m.jpg', 3600, hora + 59 * 60_000);
    const b = await r2.urlFirmada('wa/c/m.jpg', 3600, hora + 61 * 60_000);
    expect(a).not.toBe(b);
    /* Fechada a las 19:00 y válida 7200 s: pedida a las 19:59, sigue valiendo hasta las 21:00. */
    expect(a).toContain('X-Amz-Date=20260923T190000Z');
    expect(a).toContain('X-Amz-Expires=7200');
  });

  it('claves distintas, URLs distintas', async () => {
    expect(await r2.urlFirmada('a.jpg', 3600, hora)).not.toBe(await r2.urlFirmada('b.jpg', 3600, hora));
  });
});
