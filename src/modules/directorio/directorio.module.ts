import { Module } from '@nestjs/common';

import { StorageModule } from '../../common/storage/storage.module';
import { DirectorioPublicoController } from './directorio-publico.controller';
import { DirectorioController } from './directorio.controller';
import { DirectorioService } from './directorio.service';

@Module({
  imports: [StorageModule],
  controllers: [DirectorioController, DirectorioPublicoController],
  providers: [DirectorioService],
  exports: [DirectorioService],
})
export class DirectorioModule {}
