import { dimensionesImagen } from './dimensiones-imagen';

/** Cabecera PNG mínima (firma + IHDR) de ancho × alto: lo único que lee la librería. */
function png(ancho: number, alto: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 0);
  new DataView(b.buffer).setUint32(16, ancho);
  new DataView(b.buffer).setUint32(20, alto);
  return b;
}

describe('dimensionesImagen', () => {
  it('lee ancho y alto de la cabecera', () => {
    expect(dimensionesImagen(png(800, 600), 'image/png')).toEqual({ ancho: 800, alto: 600 });
  });

  it('no inventa dimensiones para lo que no es una imagen o no se entiende', () => {
    expect(dimensionesImagen(png(800, 600), 'application/pdf')).toBeNull();
    expect(dimensionesImagen(new Uint8Array([1, 2, 3]), 'image/jpeg')).toBeNull();
    expect(dimensionesImagen(png(800, 600), null)).toBeNull();
  });
});
