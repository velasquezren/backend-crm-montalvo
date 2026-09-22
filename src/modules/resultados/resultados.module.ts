import { Module } from '@nestjs/common';

import { ClientesModule } from '../clientes/clientes.module';
import { ConversacionesModule } from '../conversaciones/conversaciones.module';
import { LineasWhatsappModule } from '../lineas-whatsapp/lineas-whatsapp.module';
import { PortalResultadosClient } from './portal-resultados.client';
import { ResultadosController } from './resultados.controller';
import { ResultadosService } from './resultados.service';

/**
 * Entrega de resultados: puente entre el portal de resultados —otro sistema,
 * en el mismo servidor, detrás de loopback— y las conversaciones del CRM.
 *
 * No toca las tablas de otros dominios: pide clientes a `ClientesService`,
 * envía por `ConversacionesService` y comprueba la línea con
 * `LineasWhatsappService`. Lo único que persiste por su cuenta es
 * `AvisoResultado`, que es suyo.
 */
@Module({
  imports: [ClientesModule, ConversacionesModule, LineasWhatsappModule],
  controllers: [ResultadosController],
  providers: [PortalResultadosClient, ResultadosService],
})
export class ResultadosModule {}
