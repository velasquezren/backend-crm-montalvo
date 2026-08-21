import { Module } from '@nestjs/common';

import { HealthController } from './health.controller';

/** No exporta nada: es solo el endpoint de monitoreo, nadie más lo consume. */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
