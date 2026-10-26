import { Module } from '@nestjs/common';

import { HealthController } from './health.controller';
import { LatidoService } from './latido.service';

/** No exporta nada: el endpoint de monitoreo y el latido al monitor externo. */
@Module({
  controllers: [HealthController],
  providers: [LatidoService],
})
export class HealthModule {}
