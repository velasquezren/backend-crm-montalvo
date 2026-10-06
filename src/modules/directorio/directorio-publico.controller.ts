import { Controller, Get, Header, Param, ParseUUIDPipe, Query, StreamableFile } from '@nestjs/common';

import { Public } from '../../common/decorators/public.decorator';
import { CABECERAS_IMAGEN_PUBLICA } from '../../common/storage/imagen-publica';
import { DirectorioService } from './directorio.service';
import { QueryDirectorioPublicoDto } from './dto/perfil-medico.dto';

/** Los listados públicos cambian cuando la clínica publica algo: un minuto de caché y cinco de margen. */
const CACHE_LISTADO = 'public, max-age=60, stale-while-revalidate=300';

/**
 * El directorio que lee la landing. Sin sesión, de solo lectura y solo con lo
 * PUBLICADO: ni fichas ocultas, ni códigos internos, ni datos de pacientes.
 * Mantiene el rate-limit general (no lleva `@SkipThrottle`): es público.
 */
@Public()
@Controller('publico/directorio')
export class DirectorioPublicoController {
  constructor(private readonly service: DirectorioService) {}

  @Get('especialidades')
  @Header('Cache-Control', CACHE_LISTADO)
  especialidades(@Query() query: QueryDirectorioPublicoDto) {
    return this.service.especialidadesPublicas(query);
  }

  @Get('medicos')
  @Header('Cache-Control', CACHE_LISTADO)
  medicos(@Query() query: QueryDirectorioPublicoDto) {
    return this.service.medicosPublicos(query);
  }

  @Get('medicos/:slug')
  @Header('Cache-Control', CACHE_LISTADO)
  medico(@Param('slug') slug: string) {
    return this.service.medicoPublico(slug);
  }

  @Get('fotos/:fotoId')
  @Header('Cache-Control', CABECERAS_IMAGEN_PUBLICA['Cache-Control'])
  @Header('Cross-Origin-Resource-Policy', CABECERAS_IMAGEN_PUBLICA['Cross-Origin-Resource-Policy'])
  foto(@Param('fotoId', ParseUUIDPipe) fotoId: string): Promise<StreamableFile> {
    return this.service.fotoPublica(fotoId);
  }
}
