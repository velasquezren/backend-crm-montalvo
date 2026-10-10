import { Module } from '@nestjs/common';
import { StorageModule } from '../../common/storage/storage.module';
import { DirectorioModule } from '../directorio/directorio.module';
import { AgendaAdminClient } from './agenda-admin.client';
import { AgendaConsultaClient } from './agenda-consulta.client';
import { AgendaFlowController } from './agenda-flow.controller';
import { AgendaFlowService } from './agenda-flow.service';
import { AgendaMedicosCrmController } from './agenda-medicos-crm.controller';
import { AgendaMedicosCrmService } from './agenda-medicos-crm.service';
import { AgendaPublicaController } from './agenda-publica.controller';
import { AgendaReservasCrmController } from './agenda-reservas-crm.controller';
import { AgendaReservasCrmService } from './agenda-reservas-crm.service';
import { AgendaReservaClient } from './agenda-reserva.client';
import { AgendaReservasService } from './agenda-reservas.service';
import { AgendaTelegramService } from './agenda-telegram.service';
import { AgendaService } from './agenda.service';
import { AgendaVpsClient } from './agenda-vps.client';

@Module({
  imports: [DirectorioModule, StorageModule],
  controllers: [AgendaPublicaController, AgendaReservasCrmController, AgendaMedicosCrmController, AgendaFlowController],
  providers: [
    AgendaService, AgendaVpsClient, AgendaReservaClient, AgendaReservasService, AgendaTelegramService,
    AgendaConsultaClient, AgendaReservasCrmService, AgendaAdminClient, AgendaMedicosCrmService, AgendaFlowService,
  ],
  exports: [AgendaService, AgendaReservasService, AgendaConsultaClient, AgendaMedicosCrmService],
})
export class AgendaModule {}
