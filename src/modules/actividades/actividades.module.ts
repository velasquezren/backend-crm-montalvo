import { Module } from '@nestjs/common';

import { ClientesModule } from '../clientes/clientes.module';
import { ActividadesController } from './actividades.controller';
import { ActividadesService } from './actividades.service';

/* No importa PushModule: es @Global() (ver push.module.ts), así que
   PushService ya está disponible para inyectar sin declararlo aquí. */
@Module({
  imports: [ClientesModule],
  controllers: [ActividadesController],
  providers: [ActividadesService],
  exports: [ActividadesService],
})
export class ActividadesModule {}
