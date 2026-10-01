import { Module } from '@nestjs/common';

import { AudienciasModule } from '../audiencias/audiencias.module';
import { ConversacionesModule } from '../conversaciones/conversaciones.module';
import { TipoCambioModule } from '../tipo-cambio/tipo-cambio.module';
import { CampanasEnvioService } from './campanas-envio.service';
import { CampanasController } from './campanas.controller';
import { CampanasService } from './campanas.service';

@Module({
  imports: [AudienciasModule, ConversacionesModule, TipoCambioModule],
  controllers: [CampanasController],
  providers: [CampanasService, CampanasEnvioService],
})
export class CampanasModule {}
