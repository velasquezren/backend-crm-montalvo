import { Module } from '@nestjs/common';
import { AgendaPublicaController } from './agenda-publica.controller';
import { AgendaService } from './agenda.service';
import { AgendaVpsClient } from './agenda-vps.client';

@Module({ controllers: [AgendaPublicaController], providers: [AgendaService, AgendaVpsClient], exports: [AgendaService] })
export class AgendaModule {}
