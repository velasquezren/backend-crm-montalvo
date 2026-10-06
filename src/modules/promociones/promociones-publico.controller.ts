import { Controller, Get, Header, Param, ParseUUIDPipe, Query, StreamableFile } from '@nestjs/common';

import { Public } from '../../common/decorators/public.decorator';
import { CABECERAS_IMAGEN_PUBLICA } from '../../common/storage/imagen-publica';
import { QueryPromocionesPublicasDto } from './dto/promocion.dto';
import { PromocionesService } from './promociones.service';

/** Cambia cuando la clínica publica o pausa: un minuto de caché y cinco de margen. */
const CACHE_LISTADO = 'public, max-age=60, stale-while-revalidate=300';

/**
 * Las promociones que lee la landing. Sin sesión, de solo lectura y solo lo
 * PUBLICADO y vigente hoy en La Paz. Mantiene el rate-limit general.
 */
@Public()
@Controller('publico/promociones')
export class PromocionesPublicoController {
  constructor(private readonly service: PromocionesService) {}

  @Get()
  @Header('Cache-Control', CACHE_LISTADO)
  listar(@Query() query: QueryPromocionesPublicasDto) {
    return this.service.listarPublicas(query);
  }

  /** Declarada antes de `:slug`: Express casa en orden. */
  @Get('imagenes/:imagenId')
  @Header('Cache-Control', CABECERAS_IMAGEN_PUBLICA['Cache-Control'])
  @Header('Cross-Origin-Resource-Policy', CABECERAS_IMAGEN_PUBLICA['Cross-Origin-Resource-Policy'])
  imagen(@Param('imagenId', ParseUUIDPipe) imagenId: string): Promise<StreamableFile> {
    return this.service.imagenPublica(imagenId);
  }

  @Get(':slug')
  @Header('Cache-Control', CACHE_LISTADO)
  detalle(@Param('slug') slug: string) {
    return this.service.publicaPorSlug(slug);
  }
}
