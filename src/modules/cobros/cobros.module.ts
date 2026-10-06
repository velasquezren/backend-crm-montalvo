import { Module } from '@nestjs/common';

import { StorageModule } from '../../common/storage/storage.module';
import { CobrosController } from './cobros.controller';
import { CobrosService } from './cobros.service';

@Module({
  imports: [StorageModule],
  controllers: [CobrosController],
  providers: [CobrosService],
  exports: [CobrosService],
})
export class CobrosModule {}
