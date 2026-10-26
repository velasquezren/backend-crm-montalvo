import { Module } from '@nestjs/common';

import { StorageModule } from '../../common/storage/storage.module';
import { ClientesModule } from '../clientes/clientes.module';
import { ConversionesMetaModule } from '../conversiones-meta/conversiones-meta.module';
import { LeadsModule } from '../leads/leads.module';
import { PlanillaComisionesModule } from '../planilla-comisiones/planilla-comisiones.module';
import { VentasController } from './ventas.controller';
import { VentasService } from './ventas.service';

@Module({
  imports: [
    ClientesModule,
    LeadsModule,
    /* El aviso de la venta a Meta nace en la misma transacción que la venta. */
    ConversionesMetaModule,
    StorageModule,
    /* Solo por el catálogo de servicios y médicos que alimenta el modal. */
    PlanillaComisionesModule,
  ],
  controllers: [VentasController],
  providers: [VentasService],
  exports: [VentasService],
})
export class VentasModule {}
