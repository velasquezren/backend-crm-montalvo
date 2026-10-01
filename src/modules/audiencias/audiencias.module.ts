import { Module } from '@nestjs/common';

import { TipoCambioModule } from '../tipo-cambio/tipo-cambio.module';
import { AudienciasController } from './audiencias.controller';
import { AudienciasService } from './audiencias.service';

@Module({
  imports: [TipoCambioModule],
  controllers: [AudienciasController],
  providers: [AudienciasService],
})
export class AudienciasModule {}
