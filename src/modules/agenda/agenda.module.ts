import { Module } from '@nestjs/common';
import { StorageModule } from '../../common/storage/storage.module';
import { DirectorioModule } from '../directorio/directorio.module';
import { AccesoMedicoAgendaController } from './acceso-medico-agenda.controller';
import { AccesoMedicoAgendaService } from './acceso-medico-agenda.service';
import { AgendaAdminClient } from './agenda-admin.client';
import { AgendaConsultaClient } from './agenda-consulta.client';
import { AgendaFlowController } from './agenda-flow.controller';
import { AgendaFlowService } from './agenda-flow.service';
import { AgendaMedicoCitasService } from './agenda-medico-citas.service';
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
import { HorarioFilemakerController } from './horario-filemaker.controller';
import { HorarioFilemakerGuard } from './horario-filemaker.guard';
import { HorarioFilemakerService } from './horario-filemaker.service';

@Module({
  imports: [DirectorioModule, StorageModule],
  controllers: [AgendaPublicaController, AgendaReservasCrmController, AgendaMedicosCrmController, AccesoMedicoAgendaController, AgendaFlowController, HorarioFilemakerController],
  providers: [
    AgendaService, AgendaVpsClient, AgendaReservaClient, AgendaReservasService, AgendaTelegramService,
    AgendaConsultaClient, AgendaReservasCrmService, AgendaAdminClient, AgendaMedicosCrmService, AgendaFlowService,
    AccesoMedicoAgendaService, AgendaMedicoCitasService,
    HorarioFilemakerGuard, HorarioFilemakerService,
  ],
  exports: [AgendaService, AgendaReservasService, AgendaConsultaClient, AgendaMedicosCrmService, AccesoMedicoAgendaService, AgendaMedicoCitasService, HorarioFilemakerService],
})
export class AgendaModule {}
