import { Module } from '@nestjs/common';

import { MetaSignatureGuard } from '../../common/guards/meta-signature.guard';
import { WhatsappCloudService } from '../../common/whatsapp/whatsapp-cloud.service';
import { StorageModule } from '../../common/storage/storage.module';
import { ClientesModule } from '../clientes/clientes.module';
import { ConversacionesController } from './conversaciones.controller';
import { ConversacionesGateway } from './conversaciones.gateway';
import { ConversacionesService } from './conversaciones.service';
import { WhatsappWebhookController } from './webhooks/whatsapp-webhook.controller';

@Module({
  imports: [ClientesModule, StorageModule],
  controllers: [ConversacionesController, WhatsappWebhookController],
  providers: [
    ConversacionesService,
    ConversacionesGateway,
    MetaSignatureGuard,
    WhatsappCloudService,
  ],
  exports: [ConversacionesService],
})
export class ConversacionesModule {}
