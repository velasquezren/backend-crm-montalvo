import { Module } from '@nestjs/common';
import { PlantillasAgenteController } from './plantillas-agente.controller';
import { PlantillasAgenteService } from './plantillas-agente.service';

@Module({
  controllers: [PlantillasAgenteController],
  providers: [PlantillasAgenteService],
  exports: [PlantillasAgenteService],
})
export class PlantillasAgenteModule {}
