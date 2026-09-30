import { NotFoundException, StreamableFile } from '@nestjs/common';

import { tieneCabecera, urlDeCabecera } from './cabeceras-plantilla';
import { CabecerasPlantillaController } from './cabeceras-plantilla.controller';

/**
 * Las imágenes de cabecera viven en `assets/cabeceras/<plantilla>.jpg`. Se
 * prueba con la real, `reactivacion_con_foto.jpg`: si alguien la mueve o la
 * renombra, la plantilla deja de poder enviarse y esto cae antes.
 */
describe('cabeceras de plantilla', () => {
  it('encuentra la imagen por el nombre de la plantilla y arma su URL pública', () => {
    expect(tieneCabecera('reactivacion_con_foto')).toBe(true);
    expect(urlDeCabecera('reactivacion_con_foto', 'https://crm.prueba/')).toBe('https://crm.prueba/publico/cabeceras/reactivacion_con_foto.jpg');
  });

  it('sin imagen o sin URL pública no hay cabecera: la plantilla no se ofrece', () => {
    expect(urlDeCabecera('no_existe', 'https://crm.prueba')).toBeNull();
    expect(urlDeCabecera('reactivacion_con_foto', undefined)).toBeNull();
    expect(urlDeCabecera('reactivacion_con_foto', '   ')).toBeNull();
  });

  /* La ruta es pública: el nombre es la única barrera para leer fuera de la carpeta. */
  it('un nombre con barras o puntos nunca sale de la carpeta', () => {
    for (const nombre of ['../package', '..%2Fpackage', 'a/b', '.env', 'REACTIVACION_CON_FOTO']) {
      expect(tieneCabecera(nombre)).toBe(false);
    }
  });

  describe('la ruta pública', () => {
    const controlador = new CabecerasPlantillaController();

    it('sirve la imagen como JPEG', () => {
      const archivo = controlador.imagen('reactivacion_con_foto.jpg');
      expect(archivo).toBeInstanceOf(StreamableFile);
      expect(archivo.getHeaders().type).toBe('image/jpeg');
    });

    it('404 para lo que no es una cabecera', () => {
      for (const pedido of ['no_existe.jpg', 'reactivacion_con_foto', '..%2F..%2Fpackage.json', 'reactivacion_con_foto.png']) {
        expect(() => controlador.imagen(pedido)).toThrow(NotFoundException);
      }
    });
  });
});
