import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';

import { TrabajosService } from './trabajos.service';

/**
 * Global y sin exportar nada que haya que inyectar: los módulos marcan sus
 * métodos con `@TareaPeriodica` y `TrabajosService` los encuentra al arrancar.
 */
@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [TrabajosService],
})
export class TrabajosModule {}
