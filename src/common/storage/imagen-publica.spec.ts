import { BYTES_MAXIMOS_IMAGEN, validarImagenPublica } from './imagen-publica';
import { imagenSintetica } from './imagen-sintetica';

describe('validarImagenPublica', () => {
  it.each(['png', 'jpg', 'webp'] as const)('acepta %s y lee sus medidas de los bytes', tipo => {
    const r = validarImagenPublica(imagenSintetica(tipo, 1200, 628));
    expect(r).toEqual(expect.objectContaining({ ancho: 1200, alto: 628, extension: tipo }));
  });

  it('el tipo sale de los bytes, no del nombre ni del mimetype que diga el navegador', () => {
    expect(validarImagenPublica(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toEqual({ error: expect.any(String) });
    expect(validarImagenPublica(Buffer.from('%PDF-1.7 no soy una imagen'))).toEqual({ error: expect.any(String) });
  });

  it('rechaza vacío y más de 5 MB', () => {
    expect(validarImagenPublica(new Uint8Array(0))).toEqual({ error: 'El archivo está vacío.' });
    const grande = new Uint8Array(BYTES_MAXIMOS_IMAGEN + 1);
    grande.set(imagenSintetica('png', 1080, 1080));
    expect(validarImagenPublica(grande)).toEqual({ error: 'La imagen pesa más de 5 MB.' });
  });
});
