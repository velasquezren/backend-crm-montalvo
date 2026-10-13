import { Module } from '@nestjs/common';
import { PortalResultadosClient } from './portal-resultados.client';
import { InformesChatService } from './informes-chat.service';

/** Cliente compartido sin importar ResultadosModule (que ya usa Conversaciones). */
@Module({ providers: [PortalResultadosClient, InformesChatService], exports: [PortalResultadosClient, InformesChatService] })
export class PortalResultadosModule {}
