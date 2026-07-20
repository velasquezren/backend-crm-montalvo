import { Module } from '@nestjs/common';

import { ClientesModule } from '../clientes/clientes.module';
import { ConversacionesController } from './conversaciones.controller';
import { ConversacionesService } from './conversaciones.service';
import { WhatsappWebhookController } from './webhooks/whatsapp-webhook.controller';

@Module({
  imports: [ClientesModule],
  controllers: [ConversacionesController, WhatsappWebhookController],
  providers: [ConversacionesService],
  exports: [ConversacionesService],
})
export class ConversacionesModule {}
