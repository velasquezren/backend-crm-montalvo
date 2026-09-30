import { Controller, Get, Header, NotFoundException, Param, StreamableFile } from '@nestjs/common';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';

import { Public } from '../../common/decorators/public.decorator';
import { DIRECTORIO_CABECERAS, tieneCabecera } from './cabeceras-plantilla';

/**
 * Las imágenes de cabecera de plantillas, para que Meta las descargue al
 * enviar (ver `cabeceras-plantilla.ts`). Públicas porque Meta no se autentica;
 * no llevan datos de nadie: son la foto de la clínica y similares.
 *
 * `StreamableFile` y no el archivo devuelto a secas: Nest serializa como JSON
 * lo que no lo sea (ver la ruta del PDF de Resultados).
 */
@Public()
@Controller('publico/cabeceras')
export class CabecerasPlantillaController {
  @Get(':archivo')
  @Header('Cache-Control', 'public, max-age=86400')
  imagen(@Param('archivo') archivo: string): StreamableFile {
    const plantilla = archivo.endsWith('.jpg') ? archivo.slice(0, -'.jpg'.length) : '';
    if (!tieneCabecera(plantilla)) throw new NotFoundException('Esa imagen no existe.');
    return new StreamableFile(createReadStream(join(DIRECTORIO_CABECERAS, `${plantilla}.jpg`)), { type: 'image/jpeg' });
  }
}
