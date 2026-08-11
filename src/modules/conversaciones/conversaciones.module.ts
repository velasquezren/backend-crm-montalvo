import { Module } from '@nestjs/common';

import { MetaSignatureGuard } from '../../common/guards/meta-signature.guard';
import { AlertasWhatsappService } from '../../common/whatsapp/alertas-whatsapp.service';
import { WhatsappCloudService } from '../../common/whatsapp/whatsapp-cloud.service';
import { StorageModule } from '../../common/storage/storage.module';
import { PushModule } from '../../common/push/push.module';
import { ClientesModule } from '../clientes/clientes.module';
import { AcuseAutomaticoService } from './acuse-automatico.service';
import { ConversacionesController } from './conversaciones.controller';
import { ConversacionesGateway } from './conversaciones.gateway';
import { ConversacionesService } from './conversaciones.service';
import { DespachadorSalienteService } from './despachador-saliente.service';
import { MediaEntranteService } from './media-entrante.service';
import { WhatsappWebhookController } from './webhooks/whatsapp-webhook.controller';

@Module({
  imports: [ClientesModule, StorageModule, PushModule],
  controllers: [ConversacionesController, WhatsappWebhookController],
  providers: [
    ConversacionesService,
    ConversacionesGateway,
    AcuseAutomaticoService,
    DespachadorSalienteService,
    MediaEntranteService,
    MetaSignatureGuard,
    WhatsappCloudService,
    AlertasWhatsappService,
  ],
  exports: [ConversacionesService],
})
export class ConversacionesModule {}

