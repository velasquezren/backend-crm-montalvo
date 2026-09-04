import { Module } from '@nestjs/common';

import { ClientesModule } from '../clientes/clientes.module';
import { ConversacionesModule } from '../conversaciones/conversaciones.module';
import { ActividadesController } from './actividades.controller';
import { ActividadesService } from './actividades.service';

/* No importa PushModule: es @Global() (ver push.module.ts), así que
   PushService ya está disponible para inyectar sin declararlo aquí.
   ConversacionesModule sí hace falta: expone ConversacionesGateway, el
   socket /realtime compartido de toda la sesión — el barrido de
   recordatorios lo usa para avisar en vivo, no solo por push. */
@Module({
  imports: [ClientesModule, ConversacionesModule],
  controllers: [ActividadesController],
  providers: [ActividadesService],
  exports: [ActividadesService],
})
export class ActividadesModule {}
