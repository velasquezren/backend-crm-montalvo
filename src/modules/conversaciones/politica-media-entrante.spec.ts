import { ErrorMedia, errorHttpMedia, sanitizarErrorMedia } from '../../common/fiabilidad/error-media';
import { PLAZO_MEDIA_MS, resultadoFalloMedia } from './politica-media-entrante';

const ahora = new Date('2026-09-14T00:00:00Z');
describe('política de recuperación de media', () => {
  it.each([1, 5, 15, 60, 180, 360, 720])('aplica el backoff de %i minutos', minutos => {
    const intento = [1, 5, 15, 60, 180, 360, 720].indexOf(minutos) + 1;
    expect(resultadoFalloMedia(new ErrorMedia('RED'), intento, ahora, ahora))
      .toEqual({ estado: 'REINTENTABLE', ultimoError: 'RED', proximoIntento: new Date(ahora.getTime() + minutos * 60_000) });
  });
  it('configuración espera una hora sin adelantar el plazo final', () => {
    const creada = new Date(ahora.getTime() - PLAZO_MEDIA_MS + 30_000);
    expect(resultadoFalloMedia(new ErrorMedia('SIN_CONFIGURAR', 'CONFIGURACION'), 0, creada, ahora).proximoIntento)
      .toEqual(new Date(ahora.getTime() + 30_000));
  });
  it('el octavo fallo termina sin otra agenda', () => {
    expect(resultadoFalloMedia(new ErrorMedia('RED'), 8, ahora, ahora))
      .toEqual({ estado: 'AGOTADO', ultimoError: 'INTENTOS_AGOTADOS:RED', proximoIntento: null });
  });
  it('un error permanente descarta inmediatamente', () => {
    expect(resultadoFalloMedia(new ErrorMedia('TAMANO_EXCEDIDO', 'PERMANENTE'), 1, ahora, ahora))
      .toEqual({ estado: 'DESCARTADO', ultimoError: 'TAMANO_EXCEDIDO', proximoIntento: null });
  });
  it.each([401, 403])('credenciales rechazadas (%i) son configuración', status => {
    expect(errorHttpMedia('META_ORIGEN', status).categoria).toBe('CONFIGURACION');
    expect(errorHttpMedia('R2', status).categoria).toBe('CONFIGURACION');
  });
  it('404 depende de la etapa: origen perdido, URL caducada o bucket sin configurar', () => {
    expect(errorHttpMedia('META_ORIGEN', 404).categoria).toBe('PERMANENTE');
    expect(errorHttpMedia('META_DESCARGA', 404).categoria).toBe('TRANSITORIO');
    expect(errorHttpMedia('R2', 404).categoria).toBe('CONFIGURACION');
  });
  it.each([408, 429, 500, 503])('HTTP %i conserva posibilidad de reintento', status => {
    expect(errorHttpMedia('META_ORIGEN', status).categoria).toBe('TRANSITORIO');
  });
  it('jamás copia texto de un error externo', () => {
    expect(sanitizarErrorMedia(new Error('token=secreto https://r2/firmado')).codigo).toBe('FALLO_TRANSITORIO');
    expect(sanitizarErrorMedia(new DOMException('secreto', 'TimeoutError')).codigo).toBe('TIEMPO_AGOTADO');
    expect(sanitizarErrorMedia({ token: 'secreto' }).codigo).toBe('FALLO_TRANSITORIO');
  });
});
