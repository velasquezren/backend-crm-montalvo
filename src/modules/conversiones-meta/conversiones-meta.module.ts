import { Module } from '@nestjs/common';

import { ConversionesMetaService } from './conversiones-meta.service';

/** Dueño de `ConversionMeta`. Ventas le pide el registro dentro de su transacción. */
@Module({
  providers: [ConversionesMetaService],
  exports: [ConversionesMetaService],
})
export class ConversionesMetaModule {}
