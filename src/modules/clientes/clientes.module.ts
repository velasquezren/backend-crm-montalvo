import { Module } from '@nestjs/common';

import { ServiciosModule } from '../servicios/servicios.module';
import { TipoCambioModule } from '../tipo-cambio/tipo-cambio.module';
import { CategoriaPacienteService } from './categoria-paciente.service';
import { ClientesController } from './clientes.controller';
import { ClientesService } from './clientes.service';

@Module({
  imports: [ServiciosModule, TipoCambioModule],
  controllers: [ClientesController],
  providers: [ClientesService, CategoriaPacienteService],
  exports: [ClientesService],
})
export class ClientesModule {}
