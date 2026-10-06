import { Module } from '@nestjs/common';

import { StorageModule } from '../../common/storage/storage.module';
import { PromocionesPublicoController } from './promociones-publico.controller';
import { PromocionesController } from './promociones.controller';
import { PromocionesService } from './promociones.service';

@Module({
  imports: [StorageModule],
  controllers: [PromocionesController, PromocionesPublicoController],
  providers: [PromocionesService],
  exports: [PromocionesService],
})
export class PromocionesModule {}
