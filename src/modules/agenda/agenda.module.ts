import { Module } from '@nestjs/common';
import { AgendaPublicaController } from './agenda-publica.controller';
import { AgendaReservaClient } from './agenda-reserva.client';
import { AgendaReservasService } from './agenda-reservas.service';
import { AgendaTelegramService } from './agenda-telegram.service';
import { AgendaService } from './agenda.service';
import { AgendaVpsClient } from './agenda-vps.client';

@Module({
  controllers: [AgendaPublicaController],
  providers: [AgendaService, AgendaVpsClient, AgendaReservaClient, AgendaReservasService, AgendaTelegramService],
  exports: [AgendaService],
})
export class AgendaModule {}
