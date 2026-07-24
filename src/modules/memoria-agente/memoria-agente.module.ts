import { Module } from '@nestjs/common';
import { StorageModule } from '../../common/storage/storage.module';
import { MemoriaAgenteController } from './memoria-agente.controller';
import { MemoriaAgenteService } from './memoria-agente.service';

@Module({
  imports: [StorageModule],
  controllers: [MemoriaAgenteController],
  providers: [MemoriaAgenteService],
  exports: [MemoriaAgenteService],
})
export class MemoriaAgenteModule {}
