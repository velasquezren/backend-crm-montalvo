import { Module } from '@nestjs/common';

import { StorageModule } from '../../common/storage/storage.module';
import { ClientesModule } from '../clientes/clientes.module';
import { ConversacionesController } from './conversaciones.controller';
import { ConversacionesGateway } from './conversaciones.gateway';
import { ConversacionesService } from './conversaciones.service';
import { WhatsappSignatureGuard } from './webhooks/whatsapp-signature.guard';
import { WhatsappWebhookController } from './webhooks/whatsapp-webhook.controller';

@Module({
  imports: [ClientesModule, StorageModule],
  controllers: [ConversacionesController, WhatsappWebhookController],
  providers: [ConversacionesService, ConversacionesGateway, WhatsappSignatureGuard],
  exports: [ConversacionesService],
})
export class ConversacionesModule {}
