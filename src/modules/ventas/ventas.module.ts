import { Module } from '@nestjs/common';

import { ClientesModule } from '../clientes/clientes.module';
import { ComisionesModule } from '../comisiones/comisiones.module';
import { LeadsModule } from '../leads/leads.module';
import { VentasController } from './ventas.controller';
import { VentasService } from './ventas.service';

@Module({
  imports: [ClientesModule, ComisionesModule, LeadsModule],
  controllers: [VentasController],
  providers: [VentasService],
  exports: [VentasService],
})
export class VentasModule {}
